const fs = require('fs');
const path = require('path');
const googleSheets = require('../services/googleSheets');
const conversationMemory = require('./conversationMemory');
const campaignWorker = require('./campaignWorker');
const invoiceService = require('./invoiceService');
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
      // re-delivery/status-correction cycle can trigger again.
      if (prev.deliveredMessageSent) {
        prev.deliveredMessageSent = false;
        state.set(row.rowNumber, prev);
        stateChanged = true;
      }
      continue; // eslint-disable-line no-continue
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
