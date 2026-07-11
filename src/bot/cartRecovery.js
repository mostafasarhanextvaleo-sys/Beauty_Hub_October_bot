const config = require('../config');
const logger = require('../utils/logger');
const chatLogger = require('../utils/chatLogger');
const { runExclusive } = require('../utils/chatLock');
const conversationMemory = require('./conversationMemory');
const { pushHistory } = require('./llmAgent');
const { STAGES } = conversationMemory;

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // how often we scan for idle chats

// Only nudge customers who saw a recommendation, were asked for order details,
// or just need to confirm their order — not people still mid-way through Q&A,
// who haven't been given anything to decide on yet.
const NUDGE_ELIGIBLE_STAGES = new Set([
  STAGES.RECOMMENDED,
  STAGES.AWAIT_ORDER_DETAILS,
  STAGES.AWAIT_ORDER_CONFIRMATION,
]);

function buildNudgeMessage(session) {
  const productName = session.recommendedProduct ? session.recommendedProduct.name : null;
  if (productName) {
    return `هاي يا قمر 🌸 لسه مهتمة بـ${productName}؟ لو عندك أي سؤال أنا موجودة أساعدك تكملي.`;
  }
  return 'هاي يا قمر 🌸 لسه محتاجة مساعدة في حاجة؟ أنا موجودة لو حابة تكملي.';
}

async function scanAndSendNudges(sendMessageFn) {
  const delayMs = config.cartNudgeDelayHours * 60 * 60 * 1000;
  const now = Date.now();
  const entries = conversationMemory.getAllSessions();

  for (const [chatId, session] of entries) {
    if (!NUDGE_ELIGIBLE_STAGES.has(session.stage)) continue;
    if (session.orderPlaced || session.humanHandover) continue;
    if (session.nudgeSentAt) continue;
    if (now - (session.updatedAt || 0) < delayMs) continue;

    // eslint-disable-next-line no-await-in-loop
    await runExclusive(chatId, async () => {
      // Re-check against the freshest state once we hold the per-chat lock —
      // a real message may have arrived and changed things while we scanned.
      const fresh = conversationMemory.getSession(chatId);
      if (!NUDGE_ELIGIBLE_STAGES.has(fresh.stage)) return;
      // Belt-and-suspenders independent of stage mapping — a free-form LLM
      // conversation doesn't have a rigid linear machine underneath it, so
      // this guards directly against ever nudging a completed/handed-off chat
      // even if the coarse stage label lags reality for a turn.
      if (fresh.orderPlaced || fresh.humanHandover) return;
      if (fresh.nudgeSentAt) return;
      if (Date.now() - (fresh.updatedAt || 0) < delayMs) return;

      const message = buildNudgeMessage(fresh);
      try {
        await sendMessageFn(chatId, message);
        // Nudges are sent outside llmAgent.handleMessage, so without this the
        // LLM agent has no idea a nudge (or the product it named) was ever
        // sent — a reply like "نعم بيعمل ايه؟" would leave it with nothing to
        // resolve "it" against. Record it as a model turn so the next real
        // reply has full context, same as any other reply the agent sends.
        const updatedHistory = pushHistory((fresh.llm && fresh.llm.history) || [], 'model', message);
        conversationMemory.updateSession(chatId, { nudgeSentAt: Date.now(), llm: { history: updatedHistory } });
        chatLogger.logOutgoing({
          chatId,
          phone: fresh.chatId ? fresh.chatId.split('@')[0] : '',
          senderName: fresh.customerName || '',
          message,
          stage: fresh.stage,
          latencyMs: null,
        });
        logger.info(`Sent cart-recovery nudge to ${chatId}.`);
      } catch (err) {
        logger.error(`Failed to send cart-recovery nudge to ${chatId}.`, err);
      }
    });
  }
}

function startCartRecoveryScheduler(sendMessageFn, intervalMs = CHECK_INTERVAL_MS) {
  logger.info(
    `Cart-recovery scheduler started (nudges idle customers after ${config.cartNudgeDelayHours}h, checked every ${intervalMs / 60000}min).`
  );
  const timer = setInterval(() => {
    scanAndSendNudges(sendMessageFn).catch((err) => {
      logger.error('Cart-recovery scan failed.', err);
    });
  }, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { startCartRecoveryScheduler, scanAndSendNudges };
