const fs = require('fs');
const path = require('path');
const googleSheets = require('../services/googleSheets');
const conversationMemory = require('./conversationMemory');
const campaignWorker = require('./campaignWorker');
const invoiceService = require('./invoiceService');
const { matchShippingZone } = require('./shippingZones');
const logger = require('../utils/logger');
const { sleep } = require('../utils/helpers');
const { runExclusive } = require('../utils/chatLock');
const config = require('../config');

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

// Called by campaignWorker.js's handleOrderConfirmed when it merges a new
// item into an existing open-draft row and resets that row's Confirmation
// Status back to 'Hold' (see that function) — without this, runOrderConfirmationRequestCheck's
// `due` filter would keep skipping the row forever, since this module's own
// local state still remembers confirmationAskSent:true from the FIRST ask
// (sent before the item was added), even though the Sheet cell itself now
// reads 'Hold' again. Clearing it here is what actually lets the re-ask
// carrying the merged, up-to-date order go out.
function resetConfirmationAskState(rowNumber) {
  state.delete(rowNumber);
  saveState();
}

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
  // 2026-08-12: the two protected admin/test numbers are exempt from the
  // human-handoff cooldown under any circumstances — see
  // campaignWorker.isProtectedContact's header comment.
  if (!campaignWorker.isProtectedContact(chatId) && conversationMemory.isHumanHandoffCooldownActive(conversationMemory.getSession(chatId))) {
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
      // 2026-08-12 fix — locked per-chatId (same reasoning as
      // campaignWorker.js's every session/Sheets writer, see its comments):
      // this reads/replaces session.llm.history AND writes the same
      // Confirmed_Orders Confirmation Status cell a real-time customer reply
      // (llmAgent.js, running under whatsapp/client.js's own
      // runExclusive(message.from) lock) can also write, at any moment.
      // Without this lock, a fast "تمام" reply landing while this write is
      // still in flight could have its own genuine 'Confirmed' silently
      // reverted back to 'Pending' by this write landing second.
      //
      // 2026-08-19 audit fix: the lock above only ever prevented the two
      // WRITES from interleaving — it never stopped this callback from
      // ACTING on stale data. `row.confirmationStatus` was captured from the
      // scan snapshot at the top of this function, taken before the
      // invoice-generation network round-trip and before this lock was even
      // requested. Confirmed live failure: snapshot reads row 9 as 'Pending';
      // a customer's real "تمام" reply (a separate, correctly-locked writer)
      // sets it to 'Confirmed' a moment later; this callback then finally
      // acquires the lock and calls markInvoiceSent(9, 'Pending') — the
      // stale value — which unconditionally force-writes column J back to
      // 'Pending', silently erasing the customer's already-recorded
      // confirmation. Re-reading the row's live status from inside the lock,
      // right before the decision that depends on it, closes this — the
      // lock now actually protects what it was meant to.
      // eslint-disable-next-line no-await-in-loop
      await runExclusive(chatId, async () => {
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
        const freshRows = await googleSheets.getConfirmedOrdersPipelineRows();
        const freshRow = freshRows.find((r) => r.rowNumber === row.rowNumber);
        const liveConfirmationStatus = freshRow ? freshRow.confirmationStatus : row.confirmationStatus;
        await googleSheets.markInvoiceSent(row.rowNumber, liveConfirmationStatus);
      });
      if (awaitsConfirmation) {
        // Feeds runStalledOrderEscalationCheck's >24h clock — see its own
        // header comment for why this is tracked here rather than derived
        // from the row's order-creation Date.
        const prevState = state.get(row.rowNumber) || {};
        prevState.confirmationAskSentAt = Date.now();
        state.set(row.rowNumber, prevState);
        saveState();
      }
      logger.success(`Invoice sent to ${row.phone} (row ${row.rowNumber}, manual ${row.sendInvoiceAction} action).`);
      sentCount += 1;
    } catch (err) {
      logger.error(`Send Invoice Action failed for row ${row.rowNumber} (${row.phone}). Leaving it set so the next poll retries.`, err);
    }
  }
}

// --- 1b. Confirmation Status = Rejected -> Order Status sync (column K) ---
// 2026-08-11 (store owner directive): keeps Order Status aligned with
// Confirmation Status whenever the latter reads 'Rejected' — a rejected
// order left showing Order Status 'Processing' (the default written at
// row creation, see initializeOrderPipelineColumns) reads as if it's still
// headed out for fulfillment, which is wrong and has real
// warehouse/delivery-staff consequences if acted on literally.
//
// Deliberately a Sheet-driven poll rather than special-casing every place
// Confirmation Status can become 'Rejected' (today: llmAgent.js's chat
// rejection path via setConfirmationStatus — see orderConfirmationReplyDetector's
// caller — but also a staff member editing the Confirmation Status dropdown
// cell directly in the Sheet, which no code path "calls" at all). Polling
// the Sheet itself is the one mechanism that catches both sources uniformly,
// same reasoning as every other check in this file. Only ever moves K
// TOWARD 'Rejected' — never touches a row whose Order Status already reads
// 'Rejected' (no-op, cheap to re-check) and never overwrites any other
// Order Status value for a row that isn't itself Rejected.
async function runRejectedStatusSyncCheck() {
  const rows = await googleSheets.getConfirmedOrdersPipelineRows();
  const outOfSync = rows.filter((r) => r.confirmationStatus === 'Rejected' && r.orderStatus !== 'Rejected');
  if (outOfSync.length === 0) return;

  for (const row of outOfSync) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await googleSheets.setOrderStatus(row.rowNumber, 'Rejected');
      logger.success(`Synced Order Status to 'Rejected' for Confirmed_Orders row ${row.rowNumber} (${row.phone}) — Confirmation Status was already Rejected.`);
    } catch (err) {
      logger.error(`Failed to sync Order Status to 'Rejected' for row ${row.rowNumber} (${row.phone}). Will retry next scan.`, err);
    }
  }
}

// --- 1c. Stalled-order escalation (2026-08-12, store owner directive) ---
// A row can sit on Confirmation Status='Pending' indefinitely if the
// customer simply never replies — nothing in this file previously noticed
// or surfaced that. Fires exactly once per row (guarded by
// state.stalledEscalationSent, same one-shot convention as
// deliveredMessageSent above) once it's been Pending for longer than
// STALLED_ORDER_ESCALATION_MS, notifying the admin via WhatsApp so a human
// can follow up — deliberately does NOT auto-guess a resolution
// (Confirmed/Rejected) on the customer's behalf, since this file has no real
// signal for what they actually decided; a human is the only correct source
// of truth for a stalled reply. Clock starts from confirmationAskSentAt
// (stamped by runSendInvoiceActionCheck/runOrderConfirmationRequestCheck the
// moment the ask actually went out) — falls back to the row's own order
// Date for any row already Pending before this feature existed (2026-08-12
// cleanup: rows 4 and 6 both predate confirmationAskSentAt tracking), which
// slightly understates the true age (the ask usually goes out same-day) but
// never overstates it, so it can only escalate a genuinely-stalled row, never
// a fresh one.
const STALLED_ORDER_ESCALATION_MS = 24 * 60 * 60 * 1000;

async function runStalledOrderEscalationCheck(sendMessageFn) {
  if (!config.adminWhatsappNumber) return;
  const rows = await googleSheets.getConfirmedOrdersPipelineRows();
  const pending = rows.filter((r) => r.confirmationStatus === 'Pending');
  if (pending.length === 0) return;

  const now = Date.now();
  const adminChatId = `${config.adminWhatsappNumber}@c.us`;
  let stateChanged = false;

  for (const row of pending) {
    const prev = state.get(row.rowNumber) || {};
    if (prev.stalledEscalationSent) continue; // eslint-disable-line no-continue
    const askSentAt = prev.confirmationAskSentAt || Date.parse(row.date) || now;
    const ageMs = now - askSentAt;
    if (ageMs < STALLED_ORDER_ESCALATION_MS) continue; // eslint-disable-line no-continue

    const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
    try {
      const text =
        `⚠️ طلب معلّق بدون رد من العميل من ${ageHours} ساعة\n` +
        `صف ${row.rowNumber} — ${row.customerName || 'بدون اسم'} (${row.phone})\n` +
        `${row.products || ''} — ${row.totalPrice || ''}\n` +
        `محتاج متابعة يدوية.`;
      // eslint-disable-next-line no-await-in-loop
      await sendMessageFn(adminChatId, text);
      prev.stalledEscalationSent = true;
      logger.warn(`Confirmed_Orders row ${row.rowNumber} (${row.phone}) has been Pending for ~${ageHours}h with no reply — escalated to admin.`);
    } catch (err) {
      logger.error(`Stalled-order escalation notification failed for row ${row.rowNumber} (${row.phone}). Will retry next scan.`, err);
    } finally {
      state.set(row.rowNumber, prev);
      stateChanged = true;
    }
  }

  if (stateChanged) saveState();
}

// --- 2. Confirmation Status = Hold (column J) ---

// 2026-08-19 addition — confirmed live (chatId 88876412584107@lid, phone
// 201055990502): a fresh Confirmed_Orders row went Hold -> this check's
// confirm-ask in the very next 20s poll, landing just 27 seconds after
// Sara's own conversational reply already sounded like the order was
// finished ("شكراً ليكي... طلبك هيكون جاهز للتوصيل قريب") — a customer
// reasonably reads two different "your order" messages that close together
// as redundant, even though they're tracking genuinely different things
// (Sara's own tone vs. the Sheet's real Confirmation Status). A short grace
// window after the row's own creation Date gives that first reply room to
// land and be read before the deterministic ask follows up, without
// meaningfully delaying real order processing — a merged-draft row reopened
// to Hold (see campaignWorker.js) keeps its ORIGINAL creation Date, which is
// already well past this window by the time that happens, so this never
// delays a re-ask after an order gets a second item added to it.
const ORDER_CONFIRMATION_ASK_GRACE_MS = 2 * 60 * 1000;

async function runOrderConfirmationRequestCheck(sendMessageFn, resolvePhoneToChatIdFn) {
  const rows = await googleSheets.getConfirmedOrdersPipelineRows();
  const now = Date.now();
  const due = rows.filter((r) => {
    if (r.confirmationStatus !== 'Hold') return false;
    if ((state.get(r.rowNumber) || {}).confirmationAskSent) return false;
    const createdAt = Date.parse(r.date);
    return !Number.isFinite(createdAt) || now - createdAt >= ORDER_CONFIRMATION_ASK_GRACE_MS;
  });
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
      // 2026-08-12 fix — locked per-chatId, same reasoning as
      // runSendInvoiceActionCheck above: this is the other writer of the
      // same Confirmed_Orders Confirmation Status cell a real-time customer
      // reply can race against.
      // eslint-disable-next-line no-await-in-loop
      await runExclusive(chatId, async () => {
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
        await googleSheets.setConfirmationStatus(row.rowNumber, 'Pending');
      });
      logger.success(`Order-confirmation request sent to ${row.phone} (row ${row.rowNumber}).`);
      sentCount += 1;
      prev.confirmationAskSent = true;
      // Feeds runStalledOrderEscalationCheck's >24h clock.
      prev.confirmationAskSentAt = Date.now();
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
        //
        // 2026-08-19 — brought in line with invoiceGenerator.js's identical
        // fee logic (same Shipping Fee Override / Same-Day Express handling,
        // same "code re-verifies the zone actually has expressFeeEGP, never
        // trusts the stored label alone" reasoning) — previously this loyalty
        // total silently used the flat zone fee regardless of either, a
        // pre-existing inconsistency with what the customer's real invoice
        // showed, now closed rather than left as a second source of truth.
        const shippingZone = matchShippingZone(row.address);
        const hasShippingOverride = row.shippingFeeOverride !== undefined && row.shippingFeeOverride !== null && String(row.shippingFeeOverride).trim() !== '';
        const isExpressOrder = !hasShippingOverride && row.shippingMethod === 'express' && shippingZone && shippingZone.expressFeeEGP;
        const shippingFee = hasShippingOverride
          ? parseFloat(row.shippingFeeOverride) || 0
          : shippingZone
          ? (isExpressOrder ? shippingZone.expressFeeEGP : shippingZone.feeEGP)
          : 0;
        const orderTotal = (parseFloat(row.totalPrice) || 0) + shippingFee;
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
      // 2026-08-12 fix — locked per-chatId, same reasoning as the two checks
      // above: this also replaces session.llm.history, which a concurrent
      // real-time reply could otherwise silently clobber or be clobbered by.
      // eslint-disable-next-line no-await-in-loop
      await runExclusive(chatId, async () => {
        await sendMessageFn(chatId, text);
        appendMessageToSessionHistory(chatId, text);
        conversationMemory.updateSession(chatId, {
          awaitingFeedbackRating: true,
          feedbackRequestedAt: Date.now(),
          feedbackOrderRowNumber: row.rowNumber,
        });
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
      .then(() => runRejectedStatusSyncCheck())
      .catch((err) => logger.error('Rejected Order Status sync check failed.', err))
      .then(() => runStalledOrderEscalationCheck(sendMessageFn))
      .catch((err) => logger.error('Stalled-order escalation check failed.', err))
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
  runRejectedStatusSyncCheck,
  runStalledOrderEscalationCheck,
  resetConfirmationAskState,
};
