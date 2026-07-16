const config = require('../config');
const logger = require('../utils/logger');
const chatLogger = require('../utils/chatLogger');
const { runExclusive } = require('../utils/chatLock');
const conversationMemory = require('./conversationMemory');
const { pushHistory } = require('./llmAgent');
const { STAGES, isHumanHandoffCooldownActive } = conversationMemory;

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // how often we scan for idle chats

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
const FIRST_NUDGE_WITH_PRICE = [
  { id: 'nudge1_price_a', text: (name, price) => `يا قمر، الـ${name} اللي سألتي عليه لسه محجوز عشانك بـ${price} جنيه بس! 🌸 حابة نأكد الأوردر؟` },
  { id: 'nudge1_price_b', text: (name, price) => `هاي يا قمر، لسه فاكراك مهتمة بـ${name} (${price} جنيه) — محتاجة أي تفاصيل زيادة؟` },
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
    id: 'nudge2_shipping_a',
    text: (name, price) =>
      `يا قمر، الـ${name} اللي سألتي عليه لسه محجوز عشانك بـ${price} جنيه بس! 🌸 أكدي الأوردر خلال 24 ساعة كده وهضيفلك توصيل مجاني هدية مني ليكي 💕`,
  },
  {
    id: 'nudge2_shipping_b',
    text: (name, price) =>
      `لسه فاكراك يا قمر 💕 ${name} (${price} جنيه) في انتظارك — أكدي دلوقتي وهعملك توصيل مجاني كهدية بسيطة مني، إيه رأيك؟`,
  },
];

// Fallback for sessions with no recommendedProduct yet (e.g. still mid
// category Q&A when they went idle) — same for both stages, matches the
// original single message.
const GENERIC_NUDGE = [
  { id: 'nudge_generic', text: () => 'هاي يا قمر 🌸 لسه محتاجة مساعدة في حاجة؟ أنا موجودة لو حابة تكملي.' },
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
    // Explicit on top of the humanHandover check above (which already
    // covers this in practice, since a handed-off session's stage becomes
    // CLOSED) — named directly after the 24h cooldown concept so the intent
    // reads clearly even if the stage/humanHandover logic changes later.
    if (isHumanHandoffCooldownActive(session)) continue;
    if (!dueNudgeStage(session, now)) continue;

    // eslint-disable-next-line no-await-in-loop
    await runExclusive(chatId, async () => {
      // Re-check against the freshest state once we hold the per-chat lock —
      // a real message may have arrived and changed things while we scanned.
      const fresh = conversationMemory.getSession(chatId);
      if (!NUDGE_ELIGIBLE_STAGES.has(fresh.stage)) return;
      if (isHumanHandoffCooldownActive(fresh)) return;
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
        // resolve "it" against. Record it as a model turn so the next real
        // reply has full context, same as any other reply the agent sends.
        const updatedHistory = pushHistory((fresh.llm && fresh.llm.history) || [], 'model', message);
        const patch =
          stage === 'first'
            ? { nudgeSentAt: Date.now(), llm: { history: updatedHistory } }
            : { secondNudgeSentAt: Date.now(), llm: { history: updatedHistory } };
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
        logger.error(`Failed to send ${stage}-stage cart-recovery nudge to ${chatId}.`, err);
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
