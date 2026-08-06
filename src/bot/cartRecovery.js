const config = require('../config');
const logger = require('../utils/logger');
const chatLogger = require('../utils/chatLogger');
const { runExclusive } = require('../utils/chatLock');
const conversationMemory = require('./conversationMemory');
const { pushHistory } = require('./llmAgent');
const campaignWorker = require('./campaignWorker');
const { STAGES, isHumanHandoffCooldownActive } = conversationMemory;

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // how often we scan for idle chats

// 2026-07-30 incident: one broken contact (259944993525773@lid — send always
// throws) got retried every CHECK_INTERVAL_MS with no backoff or cap, for
// 13+ hours straight — each attempt a real puppeteer sendMessage call, which
// piled onto the same wedged-renderer failure that also blocked real
// customers. A permanently-failing send is a signal to stop, not retry
// forever: after this many consecutive failures we give up on that chat's
// nudge rather than keep hammering the client.
const MAX_CONSECUTIVE_NUDGE_FAILURES = 3;

// Only nudge customers who saw a recommendation, were asked for order details,
// or just need to confirm their order — not people still mid-way through Q&A,
// who haven't been given anything to decide on yet.
const NUDGE_ELIGIBLE_STAGES = new Set([
  STAGES.RECOMMENDED,
  STAGES.AWAIT_ORDER_DETAILS,
  STAGES.AWAIT_ORDER_CONFIRMATION,
]);

function pickVariant(variants) {
  return variants[Math.floor(Math.random() * variants.length)];
}

// Each variant has a stable id, logged via chatLogger.logOutgoing's
// variantId (same convention as prompts.js's GREETING_VARIANTS) so
// confirm-rates per phrasing can be compared later against order outcomes
// in the Leads sheet. Price-anchored on purpose — the previous single
// message ("لسه مهتمة بكذا؟") never mentioned the price the customer was
// actually deciding on, which is the single most persuasive fact available.
// 2026-08-06 fix: variant a used to say "لسه محجوز عشانك" (still reserved
// for you) — not literally true, since no inventory-hold/reservation system
// exists anywhere in this codebase (see SECOND_NUDGE_WITH_PRICE's comment
// below, which already rejected a fabricated "stock running out" claim for
// this exact honesty reason — this phrase just implied the same thing from
// the other direction and got missed). Swapped for "لسه متاح" (still
// available), which keeps the same warm, price-anchored persuasion without
// claiming an active hold that doesn't exist.
const FIRST_NUDGE_WITH_PRICE = [
  { id: 'nudge1_price_a', text: (name, price) => `الـ${name} اللي سألتي عليه لسه متاح بـ${price} جنيه بس! 🌸 حابة نأكد الأوردر؟` },
  { id: 'nudge1_price_b', text: (name, price) => `هاي، لسه فاكراك مهتمة بـ${name} (${price} جنيه) — محتاجة أي تفاصيل زيادة؟` },
];

// Second nudge: only sent if the first got no reply. The incentive here is
// real free shipping (staff waive the delivery fee at fulfillment — see the
// recoveryNote in llmAgent.js's buildLogEntryAndNotification, which flags
// this explicitly on the Sheet/admin alert so it actually gets honored) —
// deliberately NOT a % price discount, since price_quoted is validated
// digit-for-digit against the Sheet in validateModelOutput and there's no
// mechanism to compute/verify a discounted price against that check. A
// fabricated "stock running out" urgency claim is avoided for the same
// reason as before: no real inventory system backs it, and a customer
// noticing it wasn't true costs more trust than the nudge is worth.
const SECOND_NUDGE_WITH_PRICE = [
  {
    // 2026-08-06 fix: same "لسه محجوز عشانك" honesty issue as
    // FIRST_NUDGE_WITH_PRICE's variant a above, swapped the same way — the
    // real free-shipping promise right after it is unaffected and stays as-is.
    id: 'nudge2_shipping_a',
    text: (name, price) =>
      `الـ${name} اللي سألتي عليه لسه متاح بـ${price} جنيه بس! 🌸 أكدي الأوردر خلال 24 ساعة كده وهضيفلك توصيل مجاني هدية منا ليكي.`,
  },
  {
    id: 'nudge2_shipping_b',
    text: (name, price) =>
      `لسه فاكراك 🌸 ${name} (${price} جنيه) في انتظارك — أكدي دلوقتي وهعملك توصيل مجاني كهدية بسيطة منا، إيه رأيك؟`,
  },
];

// Fallback for sessions with no recommendedProduct yet (e.g. still mid
// category Q&A when they went idle) — same for both stages, matches the
// original single message.
const GENERIC_NUDGE = [
  { id: 'nudge_generic', text: () => 'هاي 🌸 لسه محتاجة مساعدة في حاجة؟ أنا موجودة لو حابة تكملي.' },
];

function buildNudgeMessage(session, nudgeStage) {
  const product = session.recommendedProduct;
  if (product && product.price) {
    const pool = nudgeStage === 'first' ? FIRST_NUDGE_WITH_PRICE : SECOND_NUDGE_WITH_PRICE;
    const variant = pickVariant(pool);
    return { message: variant.text(product.name, product.price), variantId: variant.id };
  }
  const variant = pickVariant(GENERIC_NUDGE);
  return { message: variant.text(), variantId: variant.id };
}

// Which stage (if any) a session is due for, given the current time — shared
// between the initial scan and the re-check under the per-chat lock so the
// two can't disagree about what they're about to send.
function dueNudgeStage(session, now) {
  const firstDelayMs = config.cartNudgeDelayHours * 60 * 60 * 1000;
  const secondDelayMs = config.cartNudgeSecondDelayHours * 60 * 60 * 1000;

  if (!session.nudgeSentAt) {
    return now - (session.updatedAt || 0) >= firstDelayMs ? 'first' : null;
  }
  if (!session.secondNudgeSentAt) {
    return now - session.nudgeSentAt >= secondDelayMs ? 'second' : null;
  }
  return null;
}

async function scanAndSendNudges(sendMessageFn) {
  const now = Date.now();
  const entries = conversationMemory.getAllSessions();

  for (const [chatId, session] of entries) {
    if (!NUDGE_ELIGIBLE_STAGES.has(session.stage)) continue;
    if (session.orderPlaced || session.humanHandover) continue;
    // 2026-08-06 fix: this scheduler used to be the one automated sender
    // that never checked the owner's Blocked/Bot-Paused flags — only the
    // live inbound-message handler did. A number the owner explicitly
    // marked Blocked ("as if the message never arrived") or Paused (owner
    // is handling them manually right now) could still get an unprompted
    // cart-recovery nudge.
    if (campaignWorker.isBotPausedForContact(chatId) || campaignWorker.isContactBlocked(chatId)) continue;
    // Explicit on top of the humanHandover check above (which already
    // covers this in practice, since a handed-off session's stage becomes
    // CLOSED) — named directly after the 24h cooldown concept so the intent
    // reads clearly even if the stage/humanHandover logic changes later.
    if (isHumanHandoffCooldownActive(session)) continue;
    if (session.nudgeGaveUp) continue;
    if (!dueNudgeStage(session, now)) continue;

    // eslint-disable-next-line no-await-in-loop
    await runExclusive(chatId, async () => {
      // Re-check against the freshest state once we hold the per-chat lock —
      // a real message may have arrived and changed things while we scanned.
      const fresh = conversationMemory.getSession(chatId);
      if (!NUDGE_ELIGIBLE_STAGES.has(fresh.stage)) return;
      if (isHumanHandoffCooldownActive(fresh)) return;
      if (fresh.nudgeGaveUp) return;
      // Same belt-and-suspenders re-check as orderPlaced/humanHandover below —
      // the flag could have flipped while this scan was in flight.
      if (campaignWorker.isBotPausedForContact(chatId) || campaignWorker.isContactBlocked(chatId)) return;
      // Belt-and-suspenders independent of stage mapping — a free-form LLM
      // conversation doesn't have a rigid linear machine underneath it, so
      // this guards directly against ever nudging a completed/handed-off chat
      // even if the coarse stage label lags reality for a turn.
      if (fresh.orderPlaced || fresh.humanHandover) return;
      const stage = dueNudgeStage(fresh, Date.now());
      if (!stage) return;

      const { message, variantId } = buildNudgeMessage(fresh, stage);
      try {
        await sendMessageFn(chatId, message);
        // Nudges are sent outside llmAgent.handleMessage, so without this the
        // LLM agent has no idea a nudge (or the product it named) was ever
        // sent — a reply like "نعم بيعمل ايه؟" would leave it with nothing to
        // resolve "it" against. Record it as an assistant turn so the next real
        // reply has full context, same as any other reply the agent sends.
        const updatedHistory = pushHistory((fresh.llm && fresh.llm.history) || [], 'assistant', message);
        const patch =
          stage === 'first'
            ? { nudgeSentAt: Date.now(), llm: { history: updatedHistory }, nudgeFailureCount: 0 }
            : { secondNudgeSentAt: Date.now(), llm: { history: updatedHistory }, nudgeFailureCount: 0 };
        conversationMemory.updateSession(chatId, patch);
        chatLogger.logOutgoing({
          chatId,
          phone: fresh.chatId ? fresh.chatId.split('@')[0] : '',
          senderName: fresh.customerName || '',
          message,
          stage: fresh.stage,
          latencyMs: null,
          variantId,
        });
        logger.info(`Sent ${stage}-stage cart-recovery nudge to ${chatId} (variant: ${variantId}).`);
      } catch (err) {
        // 2026-08-03 fix: a send that fails only because the WhatsApp client
        // itself isn't connected right now (a brief reconnect window, not
        // this specific contact being broken) used to count identically
        // toward the 3-strike give-up limit — a couple of reconnects in a
        // 45-min span could permanently disable a real customer's nudges for
        // reasons that had nothing to do with them. This is the one error
        // message sendMessageToChatId throws for that case (see
        // whatsapp/client.js) — skip counting it as a failure at all and
        // just retry next scan, same as the onReady gate already does for
        // each scheduler's very first run.
        if (err && err.message === 'WhatsApp client is not connected.') {
          logger.warn(`Skipped ${stage}-stage cart-recovery nudge to ${chatId} — WhatsApp client isn't connected right now. Will retry next scan (not counted as a failure).`);
          return;
        }
        const failureCount = (fresh.nudgeFailureCount || 0) + 1;
        if (failureCount >= MAX_CONSECUTIVE_NUDGE_FAILURES) {
          conversationMemory.updateSession(chatId, { nudgeFailureCount: failureCount, nudgeGaveUp: true });
          logger.error(
            `Failed to send ${stage}-stage cart-recovery nudge to ${chatId} (${failureCount} consecutive failures) — giving up on this chat's nudges.`,
            err
          );
        } else {
          conversationMemory.updateSession(chatId, { nudgeFailureCount: failureCount });
          logger.error(`Failed to send ${stage}-stage cart-recovery nudge to ${chatId} (${failureCount}/${MAX_CONSECUTIVE_NUDGE_FAILURES}).`, err);
        }
      }
    });
  }
}

function startCartRecoveryScheduler(sendMessageFn, intervalMs = CHECK_INTERVAL_MS) {
  logger.info(
    `Cart-recovery scheduler started (1st nudge after ${config.cartNudgeDelayHours}h, 2nd after ${config.cartNudgeSecondDelayHours}h more, checked every ${intervalMs / 60000}min).`
  );
  const timer = setInterval(() => {
    scanAndSendNudges(sendMessageFn).catch((err) => {
      logger.error('Cart-recovery scan failed.', err);
    });
  }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { startCartRecoveryScheduler, scanAndSendNudges };
