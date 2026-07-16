const fs = require('fs');
const path = require('path');
const googleSheets = require('../services/googleSheets');
const conversationMemory = require('./conversationMemory');
const logger = require('../utils/logger');
const { sleep } = require('../utils/helpers');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — a staff Sheet edit isn't time-critical to react to
const STATE_PATH = path.join(__dirname, '..', '..', 'delivery_followup_state.json');
// Small pacing delay if several rows are marked "Delivered" in the same poll
// — same spam-avoidance reasoning as whatsapp/client.js's broadcast feature,
// just a lighter touch since this is naturally low-volume (staff manually
// editing individual rows, not a mass send).
const SEND_DELAY_MS = 4000;

// "المندوب بلغنا إن الأوردر وصلك.. حبيت أطمن منك كل حاجة تمام واستلمتيه كله
// تمام؟" per the store owner's spec (2026-07-16) — "يا قمر" dropped from
// their example wording to stay consistent with the pet-name-ban correction
// approved earlier the same day (corrections.json); flagged to them at the
// time rather than silently split the difference either way.
const DELIVERED_FOLLOWUP_MESSAGE = 'المندوب بلغنا إن الأوردر وصلك.. حبيت أطمن منك كل حاجة تمام واستلمتيه كله تمام؟ 🥰';

// phone -> { followupSent: boolean } — tracks whether the "did it arrive
// ok?" message has already gone out for the CURRENT Delivered episode, so
// re-polling an unanswered row doesn't resend every 5 minutes. Reset to
// false the moment a row's status is observed to be anything other than
// Delivered, so a future repeat order's delivery cycle can trigger again.
let state = new Map();

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (Array.isArray(raw)) state = new Map(raw);
  } catch (err) {
    logger.error('Failed to load delivery follow-up state. Starting fresh.', err);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify([...state.entries()]));
  } catch (err) {
    logger.error('Failed to persist delivery follow-up state.', err);
  }
}

loadState();

// sendMessageFn(chatId, text) and resolvePhoneToChatIdFn() are injected from
// index.js (bound to whatsapp/client.js) — same dependency-injection pattern
// as cartRecovery.js's startCartRecoveryScheduler, so this module never
// needs to know about the WhatsApp client directly.
async function checkForDeliveredOrders(sendMessageFn, resolvePhoneToChatIdFn) {
  const rows = await googleSheets.scanLeadsStatuses();
  if (rows.length === 0) return;

  const phoneToChatId = await resolvePhoneToChatIdFn();
  let sentCount = 0;

  for (const { phone, orderStatus } of rows) {
    const prev = state.get(phone) || { followupSent: false };

    if (orderStatus === 'Delivered' && !prev.followupSent) {
      const chatId = phoneToChatId.get(phone);
      if (!chatId) {
        logger.warn(`Order for ${phone} is marked "Delivered" but no matching WhatsApp chat was found — cannot send the follow-up.`);
      } else {
        try {
          if (sentCount > 0) await sleep(SEND_DELAY_MS);
          await sendMessageFn(chatId, DELIVERED_FOLLOWUP_MESSAGE);
          conversationMemory.updateSession(chatId, { awaitingDeliveryFeedback: true });
          logger.success(`Delivery follow-up sent to ${phone}.`);
          sentCount += 1;
        } catch (err) {
          logger.error(`Failed to send delivery follow-up to ${phone}.`, err);
        }
      }
      prev.followupSent = true;
    } else if (orderStatus !== 'Delivered') {
      prev.followupSent = false;
    }

    state.set(phone, prev);
  }

  if (sentCount > 0) saveState();
}

function startDeliveryFollowupScheduler(sendMessageFn, resolvePhoneToChatIdFn, intervalMs = CHECK_INTERVAL_MS) {
  const timer = setInterval(() => {
    checkForDeliveredOrders(sendMessageFn, resolvePhoneToChatIdFn).catch((err) =>
      logger.error('Delivery follow-up check crashed.', err)
    );
  }, intervalMs);
  if (timer.unref) timer.unref();
  logger.info(`Delivery follow-up scheduler started (checking every ${intervalMs / 60000} min for rows manually marked "Delivered").`);
}

module.exports = { startDeliveryFollowupScheduler, checkForDeliveredOrders, DELIVERED_FOLLOWUP_MESSAGE };
