// Verifies the 2026-08-11 cart-recovery simplification (store owner
// directive: the old two-stage "nudge" sequence read as repeated pestering;
// replaced with a single one-shot "cart summary card" — item, total, one
// CTA — never repeated unless the customer writes back first). Same safe
// stubbed-module pattern as _tmp_test_cart_recovery_independent_of_sheets.js
// (never touch the real sessions_state.json / conversationMemory module).
const assert = require('assert');

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');

const STAGES = { NEW: 'NEW', AWAIT_CATEGORY: 'AWAIT_CATEGORY', AWAIT_ATTRIBUTE: 'AWAIT_ATTRIBUTE', RECOMMENDED: 'RECOMMENDED', AWAIT_ORDER_DETAILS: 'AWAIT_ORDER_DETAILS', AWAIT_ORDER_CONFIRMATION: 'AWAIT_ORDER_CONFIRMATION', CLOSED: 'CLOSED' };

const fakeSessions = new Map();
const conversationMemoryStub = {
  STAGES,
  getSession(chatId) { return fakeSessions.get(chatId); },
  getAllSessions() { return [...fakeSessions.entries()]; },
  updateSession(chatId, patch) {
    Object.assign(fakeSessions.get(chatId), patch);
    return fakeSessions.get(chatId);
  },
  isHumanHandoffCooldownActive() { return false; },
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

const campaignWorkerStub = { isBotPausedForContact: () => false, isContactBlocked: () => false, isProtectedContact: () => false };
require.cache[campaignWorkerPath] = { id: campaignWorkerPath, filename: campaignWorkerPath, loaded: true, exports: campaignWorkerStub };

const cartRecoveryPath = require.resolve('../src/bot/cartRecovery');
delete require.cache[cartRecoveryPath];
const cartRecovery = require(cartRecoveryPath);

(async () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.now();

  // Scenario 1: a customer with a pinned product, idle past the delay —
  // expect exactly one cart summary card naming the product and its price
  // as the total, with one CTA.
  fakeSessions.set('with_product@lid', {
    chatId: 'with_product@lid',
    stage: STAGES.RECOMMENDED,
    recommendedProduct: { id: '30', name: 'صن بلوك ديرماتيك SPF 50 (Dermatique Sunblock SPF 50)', price: '200£' },
    updatedAt: now - 4 * HOUR,
    llm: { history: [] },
  });
  // Scenario 2: no recommendedProduct yet — falls back to the plain
  // check-in text, not a broken/empty "card".
  fakeSessions.set('no_product@lid', {
    chatId: 'no_product@lid',
    stage: STAGES.AWAIT_ORDER_DETAILS,
    recommendedProduct: null,
    updatedAt: now - 4 * HOUR,
    llm: { history: [] },
  });

  const sent = [];
  const sendMessageFn = async (chatId, message) => { sent.push({ chatId, message }); };

  await cartRecovery.scanAndSendNudges(sendMessageFn);

  assert.strictEqual(sent.length, 2, `expected exactly 2 messages on the first scan (one per eligible session), got ${sent.length}`);
  const cardMsg = sent.find((s) => s.chatId === 'with_product@lid').message;
  assert.ok(cardMsg.includes('صن بلوك ديرماتيك'), 'card must name the actual pinned product');
  assert.ok(cardMsg.includes('200£'), 'card must show the price as the total');
  assert.ok((cardMsg.match(/تحبي نأكد الأوردر/g) || []).length === 1, 'card must have exactly one call-to-action');
  const genericMsg = sent.find((s) => s.chatId === 'no_product@lid').message;
  assert.ok(genericMsg && genericMsg.length > 0, 'no-product session still gets a plain check-in, not a blank/broken message');

  // Immediately re-scan: must NOT repeat for either chat (one-shot).
  const sentAfterRepeatScan = [];
  await cartRecovery.scanAndSendNudges(async (chatId, message) => { sentAfterRepeatScan.push({ chatId, message }); });
  assert.strictEqual(sentAfterRepeatScan.length, 0, 'expected zero repeats on the immediate next scan — no more multi-step nudging');

  // Simulate the customer replying (llmAgent.js clears nudgeSentAt on any
  // inbound message) and going idle again — exactly one fresh card should
  // be eligible, not a resumed sequence.
  fakeSessions.get('with_product@lid').nudgeSentAt = null;
  fakeSessions.get('with_product@lid').updatedAt = now - 4 * HOUR;
  const sentAfterReply = [];
  await cartRecovery.scanAndSendNudges(async (chatId, message) => { sentAfterReply.push({ chatId, message }); });
  assert.strictEqual(sentAfterReply.length, 1, 'expected exactly one fresh card for the chat that replied and went idle again');
  assert.strictEqual(sentAfterReply[0].chatId, 'with_product@lid');

  console.log('PASS: cart-recovery now sends exactly one cart-summary card per abandonment episode, never a repeated sequence.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
