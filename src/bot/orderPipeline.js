const fs = require('fs');
const path = require('path');
const googleSheets = require('../services/googleSheets');
const conversationMemory = require('./conversationMemory');
const campaignWorker = require('./campaignWorker');
const invoiceService = require('./invoiceService');
const { matchShippingZone } = require('./shippingZones');
const logger = require('../utils/logger');
const { sleep } = require('../utils/helpers');

// 2026-08-09 order-management pipeline (Confirmed_Orders columns I:K) — three
// deterministic Sheet-driven automations, modeled directly on the existing
// campaignWorker.js (runSendNowCheck/runTestTriggerCheck's poll -> act ->
// reset-column pattern) and the retired deliveryFollowup.js (guard checks,
// state-file, scanInProgress mutual exclusion). Replaces the old Leads-sheet
// "Order Status" -> deliveryFollowup.js flow entirely — this file is now the
// single source of truth for post-order delivery tracking, so a customer is
// never double-messaged by two independent systems both reacting to
// "delivered".
//
// 2026-08-10: runOrderDeliveredCheck also records the order into
// Trusted_Clients (see googleSheets.upsertTrustedClient) the first time each
// row is observed as Delivered — separate from the rating-request DM this
// same check already sends. Trusted_Clients is a customer loyalty/lifetime-
// purchasing tracker (Total Lifetime Spent + Points both accumulate across
// every delivered order, Number of Purchases increments by 1 each time, Last
// Order Date is overwritten with this order's date, and Customer Tier is
// auto-recomputed from the fresh purchase count — see computeCustomerTier in
// googleSheets.js), not a row-per-order log — see TRUSTED_CLIENTS_HEADERS.
// Confirmed_Orders' own "Total Price" column is product-price-only (see
// llmAgent.js's orderHistoryEntry.price), so the shipping fee is computed
// here the same deterministic way invoiceGenerator.js already does for the
// printable invoice — via shippingZones.matchShippingZone(address) — rather
// than trusting an LLM-invented number, per this codebase's established
// "code computes it, the model never invents it" rule for money fields.
// Known limitation, inherited from invoiceGenerator.js's own identical
// approach: a customer who was promised free shipping (cartRecovery.js's
// FREE_SHIPPING_EXCEPTION) isn't tracked on the Confirmed_Orders row itself,
// so their historical order's shipping still gets counted here — the same
// gap already accepted for the invoice, not a new one introduced by this
// feature.
const SEND_INTERVAL_MS = 20 * 1000; // Send Invoice Action / Confirmation Status — cheap, eager, one-shot triggers
const DELIVERED_INTERVAL_MS = 5 * 60 * 1000; // Order Status=Delivered — staff-edited, not time-critical (same cadence the retired deliveryFollowup.js used)
const SEND_DELAY_MS = 4000; // pacing if several rows are due in the same poll — same reasoning as campaignWorker.js/deliveryFollowup.js

const STATE_PATH = path.join(__dirname, '..', '..', 'order_pipeline_state.json');

// rowNumber -> { confirmationAskSent: boolean, deliveredMessageSent: boolean }
// Keyed by rowNumber (not phone, unlike the retired deliveryFollowup.js's
// phone-keyed state) — more precise, since each Confirmed_Orders row is a
// distinct order, and a repeat customer's new order must not inherit an old
// row's "already sent" flag.
let state = new Map();

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (Array.isArray(raw)) state = new Map(raw);
  } catch (err) {
    logger.error('Failed to load order-pipeline state. Starting fresh.', err);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify([...state.entries()]));
  } catch (err) {
    logger.error('Failed to persist order-pipeline state.', err);
  }
}

loadState();

// Records an automated outbound message into the customer's own session
// history as an 'assistant' turn — same reasoning as
// campaignWorker.appendOfferToSessionHistory (not reused directly: that
// function also resets noProgressTurns/humanHandover, which is the right
// call for a marketing outreach but not obviously so for an order-pipeline
// message) — so the next real reply is understood in context instead of the
// LLM having no idea this message was ever sent.
function appendMessageToSessionHistory(chatId, text) {
  const session = conversationMemory.getSession(chatId);
  const history = (session.llm && session.llm.history) || [];
  const nextHistory = [...history, { role: 'assistant', content: text }];
  conversationMemory.updateSession(chatId, { llm: { history: nextHistory } });
}

// Shared guards before sending anything to a resolved chatId — same three
// checks the retired deliveryFollowup.js applied (human-handoff cooldown,
// Bot Paused, Blocked). Returns a skip reason string, or null if OK to send.
function guardReasonFor(chatId) {
  if (conversationMemory.isHumanHandoffCooldownActive(conversationMemory.getSession(chatId))) {
    return 'customer is in the 24h human handoff cooldown';
  }
  if (campaignWorker.isBotPausedForContact(chatId) || campaignWorker.isContactBlocked(chatId)) {
    return 'contact is Blocked or Bot Paused';
  }
  return null;
}

// --- 1. Send Invoice Action (column I) ---

async function runSendInvoiceActionCheck(sendMessageFn, resolvePhoneToChatIdFn) {
  const rows = await googleSheets.getConfirmedOrdersPipelineRows();
  const triggered = rows.filter((r) => r.sendInvoiceAction === 'Send Invoice' || r.sendInvoiceAction === 'Resend');
  if (triggered.length === 0) return;

  const phoneToChatId = await resolvePhoneToChatIdFn();
  let sentCount = 0;

  for (const row of triggered) {
    const chatId = phoneToChatId.get(row.phone);
    try {
      if (!chatId) {
        logger.warn(`Send Invoice Action was set for row ${row.rowNumber} (${row.phone}), but no matching WhatsApp chat was found. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      const guardReason = guardReasonFor(chatId);
      if (guardReason) {
        logger.warn(`Send Invoice Action was set for row ${row.rowNumber} (${row.phone}), but ${guardReason} — not sending. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      const invoice = await invoiceService.generateAndAttachInvoice({ rowNumber: row.rowNumber });
      if (!invoice) {
        logger.warn(`Send Invoice Action: could not generate an invoice link for row ${row.rowNumber} — not sending. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      if (sentCount > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(SEND_DELAY_MS);
      }
      // 2026-08-10: once this send also flips Confirmation Status to
      // 'Pending' below, the row is genuinely awaiting the customer's
      // reply — so the message must actually ask for one (same prompt as
      // runOrderConfirmationRequestCheck), and the session must be armed
      // the same way, or a "تمام"/رفض reply after a manual (Re)send would
      // never be picked up (orderConfirmationReplyDetector.js is only
      // consulted when session.awaitingOrderConfirmationReply is true) —
      // the row would sit stuck on 'Pending' forever with no automated path
      // to Confirmed/Rejected. Skipped only when the order is already
      // resolved (Confirmed/Rejected) — resending a settled order's invoice
      // shouldn't re-open it or re-prompt the customer.
      const awaitsConfirmation = !['Confirmed', 'Rejected'].includes(row.confirmationStatus);
      const text = awaitsConfirmation
        ? `أهلاً ${row.customerName || ''} 🌸 دي فاتورة طلبك: ${row.products || ''} — ${row.totalPrice || ''}. تقدري تفتحيها من هنا: ${invoice.url}\n` +
          `تأكدي الأوردر بالرد بكلمة "تأكيد" أو "تمام".`
        : `أهلاً ${row.customerName || ''} 🌸 دي فاتورة طلبك: ${row.products || ''} — ${row.totalPrice || ''}. تقدري تفتحيها من هنا: ${invoice.url}`;
      // eslint-disable-next-line no-await-in-loop
      await sendMessageFn(chatId, text);
      appendMessageToSessionHistory(chatId, text);
      if (awaitsConfirmation) {
        conversationMemory.updateSession(chatId, {
          awaitingOrderConfirmationReply: true,
          orderConfirmationRequestedAt: Date.now(),
          pendingConfirmedOrderRow: row.rowNumber,
        });
      }
      // Only write 'Sent' (+ 'Pending', see markInvoiceSent) on a confirmed
      // successful send — a transient failure leaves 'Send Invoice'/'Resend'
      // visible so the next poll retries it, same convention as
      // campaignWorker.js's clearOfferTestTrigger.
      // eslint-disable-next-line no-await-in-loop
      await googleSheets.markInvoiceSent(row.rowNumber, row.confirmationStatus);
      logger.success(`Invoice sent to ${row.phone} (row ${row.rowNumber}, manual ${row.sendInvoiceAction} action).`);
      sentCount += 1;
    } catch (err) {
      logger.error(`Send Invoice Action failed for row ${row.rowNumber} (${row.phone}). Leaving it set so the next poll retries.`, err);
    }
  }
}

// --- 2. Confirmation Status = Hold (column J) ---

async function runOrderConfirmationRequestCheck(sendMessageFn, resolvePhoneToChatIdFn) {
  const rows = await googleSheets.getConfirmedOrdersPipelineRows();
  const due = rows.filter((r) => r.confirmationStatus === 'Hold' && !(state.get(r.rowNumber) || {}).confirmationAskSent);
  if (due.length === 0) return;

  const phoneToChatId = await resolvePhoneToChatIdFn();
  let sentCount = 0;
  let stateChanged = false;

  for (const row of due) {
    const chatId = phoneToChatId.get(row.phone);
    const prev = state.get(row.rowNumber) || {};
    try {
      if (!chatId) {
        logger.warn(`Confirmed_Orders row ${row.rowNumber} (${row.phone}) is on Hold, but no matching WhatsApp chat was found. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      const guardReason = guardReasonFor(chatId);
      if (guardReason) {
        logger.info(`Skipping order-confirmation request for row ${row.rowNumber} (${row.phone}) — ${guardReason}. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      // eslint-disable-next-line no-await-in-loop
      const invoice = await invoiceService.generateAndAttachInvoice({ rowNumber: row.rowNumber });
      if (!invoice) {
        logger.warn(`Order-confirmation request: could not generate an invoice link for row ${row.rowNumber} — not sending. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      if (sentCount > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(SEND_DELAY_MS);
      }
      const text =
        `أهلاً ${row.customerName || ''} 🌸 دي تفاصيل طلبك: ${row.products || ''} — ${row.totalPrice || ''}. ` +
        `تقدري تفتحي فاتورتك من هنا: ${invoice.url}\n` +
        `تأكدي الأوردر بالرد بكلمة "تأكيد" أو "تمام".`;
      // eslint-disable-next-line no-await-in-loop
      await sendMessageFn(chatId, text);
      appendMessageToSessionHistory(chatId, text);
      conversationMemory.updateSession(chatId, {
        awaitingOrderConfirmationReply: true,
        orderConfirmationRequestedAt: Date.now(),
        pendingConfirmedOrderRow: row.rowNumber,
      });
      // Flip Hold -> Pending now that the ask has actually gone out — makes
      // "already asked, awaiting reply" visible directly on the Sheet
      // (staff-readable) instead of only in this file's local state.json,
      // and doubles as a second guard against re-asking the same row (the
      // `due` filter above only matches confirmationStatus === 'Hold').
      // eslint-disable-next-line no-await-in-loop
      await googleSheets.setConfirmationStatus(row.rowNumber, 'Pending');
      logger.success(`Order-confirmation request sent to ${row.phone} (row ${row.rowNumber}).`);
      sentCount += 1;
      prev.confirmationAskSent = true;
    } catch (err) {
      logger.error(`Order-confirmation request failed for row ${row.rowNumber} (${row.phone}). Will retry next scan.`, err);
    } finally {
      state.set(row.rowNumber, prev);
      stateChanged = true;
    }
  }

  if (stateChanged) saveState();
}

// --- 3. Order Status = Delivered (column K) ---

async function runOrderDeliveredCheck(sendMessageFn, resolvePhoneToChatIdFn) {
  const rows = await googleSheets.getConfirmedOrdersPipelineRows();
  const phoneToChatId = await resolvePhoneToChatIdFn();
  let sentCount = 0;
  let stateChanged = false;

  for (const row of rows) {
    const prev = state.get(row.rowNumber) || {};

    if (row.orderStatus !== 'Delivered') {
      // Parity with the retired deliveryFollowup.js: reset so a future
      // re-delivery/status-correction cycle can trigger again. Deliberately
      // does NOT reset trustedClientSynced below — once a customer has
      // proven out a real delivered order they stay in Trusted_Clients even
      // if staff later edits Order Status back (e.g. correcting a mistake),
      // rather than silently dropping them from a trust list because of an
      // unrelated status edit.
      if (prev.deliveredMessageSent) {
        prev.deliveredMessageSent = false;
        state.set(row.rowNumber, prev);
        stateChanged = true;
      }
      continue; // eslint-disable-line no-continue
    }

    // Trusted_Clients loyalty sync — deliberately independent of the
    // rating-request messaging below (own guard, no chatId/messaging-guard
    // dependency), so a customer who's Blocked/Bot-Paused or has no
    // resolvable WhatsApp chat still has this order counted toward their
    // loyalty stats; only the "did it arrive, rate us" DM is gated on
    // actually being able to message them. Guarded by trustedClientSynced so
    // a row already counted (deliveredMessageSent flips back to false if
    // staff un-marks Delivered, but this flag deliberately never does — see
    // the comment above) is never double-counted into the accumulating
    // totals even if this scan somehow ran twice for the same row.
    if (!prev.trustedClientSynced) {
      try {
        // upsertTrustedClient rounds the accumulated totals itself — no need
        // to round this per-order figure before handing it off.
        const shippingZone = matchShippingZone(row.address);
        const orderTotal = (parseFloat(row.totalPrice) || 0) + (shippingZone ? shippingZone.feeEGP : 0);
        // eslint-disable-next-line no-await-in-loop
        await googleSheets.upsertTrustedClient({
          customerName: row.customerName,
          phone: row.phone,
          address: row.address,
          orderTotal,
          // The Confirmed_Orders row's own order date — same value already
          // shown in that tab's "Date" column, not a separate "when it was
          // marked Delivered" timestamp this codebase doesn't track anywhere.
          orderDate: row.date,
        });
        prev.trustedClientSynced = true;
      } catch (err) {
        logger.error(`Trusted_Clients loyalty sync failed for row ${row.rowNumber} (${row.phone}). Will retry next scan.`, err);
      } finally {
        state.set(row.rowNumber, prev);
        stateChanged = true;
      }
    }

    if (prev.deliveredMessageSent) continue; // eslint-disable-line no-continue

    const chatId = phoneToChatId.get(row.phone);
    try {
      if (!chatId) {
        logger.warn(`Confirmed_Orders row ${row.rowNumber} (${row.phone}) is marked Delivered, but no matching WhatsApp chat was found. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      const guardReason = guardReasonFor(chatId);
      if (guardReason) {
        logger.info(`Skipping delivery/rating request for row ${row.rowNumber} (${row.phone}) — ${guardReason}. Will retry next scan.`);
        continue; // eslint-disable-line no-continue
      }
      if (sentCount > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(SEND_DELAY_MS);
      }
      const text = 'وصلك طلبك؟ 🌸 حابين نعرف رأيك! قيمي تجربتك معانا من 1 لـ5 وسيبلنا تعليق لو حابة.';
      // eslint-disable-next-line no-await-in-loop
      await sendMessageFn(chatId, text);
      appendMessageToSessionHistory(chatId, text);
      conversationMemory.updateSession(chatId, {
        awaitingFeedbackRating: true,
        feedbackRequestedAt: Date.now(),
        feedbackOrderRowNumber: row.rowNumber,
      });
      logger.success(`Delivery/rating request sent to ${row.phone} (row ${row.rowNumber}).`);
      sentCount += 1;
      prev.deliveredMessageSent = true;
    } catch (err) {
      logger.error(`Delivery/rating request failed for row ${row.rowNumber} (${row.phone}). Will retry next scan.`, err);
    } finally {
      state.set(row.rowNumber, prev);
      stateChanged = true;
    }
  }

  if (stateChanged) saveState();
}

// Mutual-exclusion guards, one per timer — same 2026-07-30 lesson the
// retired deliveryFollowup.js already applied: a slow/stuck scan must never
// stack with the next tick and pile up hammering a wedged WhatsApp client.
let fastScanInProgress = false;
let deliveredScanInProgress = false;

function startOrderPipelineScheduler(sendMessageFn, resolvePhoneToChatIdFn) {
  const fastTimer = setInterval(() => {
    if (fastScanInProgress) {
      logger.warn('Order-pipeline fast scan still running from a previous tick — skipping this tick rather than overlapping.');
      return;
    }
    fastScanInProgress = true;
    Promise.resolve()
      .then(() => runSendInvoiceActionCheck(sendMessageFn, resolvePhoneToChatIdFn))
      .catch((err) => logger.error('Send Invoice Action check failed.', err))
      .then(() => runOrderConfirmationRequestCheck(sendMessageFn, resolvePhoneToChatIdFn))
      .catch((err) => logger.error('Order-confirmation request check failed.', err))
      .finally(() => {
        fastScanInProgress = false;
      });
  }, SEND_INTERVAL_MS);
  if (fastTimer.unref) fastTimer.unref();

  const deliveredTimer = setInterval(() => {
    if (deliveredScanInProgress) {
      logger.warn('Order-pipeline delivered scan still running from a previous tick — skipping this tick rather than overlapping.');
      return;
    }
    deliveredScanInProgress = true;
    runOrderDeliveredCheck(sendMessageFn, resolvePhoneToChatIdFn)
      .catch((err) => logger.error('Delivered/rating request check failed.', err))
      .finally(() => {
        deliveredScanInProgress = false;
      });
  }, DELIVERED_INTERVAL_MS);
  if (deliveredTimer.unref) deliveredTimer.unref();

  logger.info(
    `Order-pipeline scheduler started (Send Invoice Action/Confirmation Status every ${SEND_INTERVAL_MS / 1000}s, Order Status=Delivered every ${DELIVERED_INTERVAL_MS / 60000} min).`
  );
}

module.exports = {
  startOrderPipelineScheduler,
  // Exported for isolated testing — startOrderPipelineScheduler's own timers
  // are what drive these in production.
  runSendInvoiceActionCheck,
  runOrderConfirmationRequestCheck,
  runOrderDeliveredCheck,
};
