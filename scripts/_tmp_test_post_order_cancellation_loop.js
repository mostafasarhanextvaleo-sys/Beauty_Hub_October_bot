// Regression test (not committed) for the 2026-08-09 P0 audit finding,
// confirmed live (chatId 33561512034419@lid): a real customer with a
// CONFIRMED order tried to cancel it 8 separate times using natural
// colloquial phrasing ("هلغي الاوردر", "مش هستلم الاوردر", "م عوزاه", ...)
// and NONE of ORDER_CANCELLATION_REQUEST_KEYWORDS matched any of them — every
// attempt fell through to general consultation, which repeated the exact
// same "contact customer service" sentence 4 times verbatim with no phone
// number and no real escalation ever firing. Two fixes: (1) expanded keyword
// coverage for the exact real phrasings that were missed, (2) a general
// safety net in llmAgent.js that escalates to a human the moment Sara's
// reply would repeat byte-identically while a real order is confirmed,
// regardless of what triggered it.
const assert = require('assert');

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const openaiServicePath = require.resolve('../src/services/openaiService');
const geminiServicePath = require.resolve('../src/services/geminiService');
const productSearchPath = require.resolve('../src/bot/productSearch');
const productMatcherPath = require.resolve('../src/bot/productMatcher');
const campaignKnowledgePath = require.resolve('../src/bot/campaignKnowledge');
const routineBundlesPath = require.resolve('../src/bot/routineBundles');
const trainingDataLoggerPath = require.resolve('../src/utils/trainingDataLogger');
const agentStatsPath = require.resolve('../src/bot/agentStats');
const googleSheetsPath = require.resolve('../src/services/googleSheets');

const fakeSessions = new Map();
const conversationMemoryStub = {
  STAGES: { NEW: 'NEW', CLOSED: 'CLOSED', RECOMMENDED: 'RECOMMENDED', AWAIT_CATEGORY: 'AWAIT_CATEGORY', AWAIT_ORDER_DETAILS: 'AWAIT_ORDER_DETAILS', AWAIT_ORDER_CONFIRMATION: 'AWAIT_ORDER_CONFIRMATION' },
  getSession(chatId) {
    if (!fakeSessions.has(chatId)) fakeSessions.set(chatId, { chatId, llm: { history: [] }, updatedAt: Date.now() });
    return fakeSessions.get(chatId);
  },
  updateSession(chatId, patch) {
    Object.assign(conversationMemoryStub.getSession(chatId), patch, { updatedAt: Date.now() });
    return conversationMemoryStub.getSession(chatId);
  },
  resetSession(chatId) { fakeSessions.delete(chatId); },
  isOrderConfirmationReplyExpired() { return false; },
  isFeedbackRatingExpired() { return false; },
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

// The general LLM tier stubbed to reproduce the EXACT real behavior: it just
// keeps repeating the same unhelpful deflection, verbatim, turn after turn —
// this is deliberately "dumb" to prove the CODE-level guard catches it
// regardless of what the model does, not because the model is expected to
// behave this way.
const DEFLECTION_REPLY = 'أفهم تمامًا، لو قررتي مش تستلمي الأوردر، ممكن تتواصلي مع فريق خدمة العملاء عشان يساعدوك في إلغاء الطلب. لو احتجتي أي مساعدة تانية، أنا هنا!';
require.cache[openaiServicePath] = {
  id: openaiServicePath,
  filename: openaiServicePath,
  loaded: true,
  exports: {
    async generateStructuredReply() {
      return {
        intent: 'GENERAL_QUESTION',
        mentioned_product_ids: [],
        price_quoted: null,
        routine_bundle_suggested_id: null,
        routine_bundle_price_quoted: null,
        order_data: { customer_name: null, delivery_address: null, alt_phone: null, confirmed: false },
        human_handover: false,
        handover_reason: null,
        reply_text: DEFLECTION_REPLY,
      };
    },
  },
};
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: { async generateStructuredReply() { return null; } } };
require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: { async searchProducts() { return []; } } };
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: { getById() { return null; }, getAllProducts() { return []; } } };
require.cache[campaignKnowledgePath] = { id: campaignKnowledgePath, filename: campaignKnowledgePath, loaded: true, exports: { getActiveOffers() { return []; } } };
require.cache[routineBundlesPath] = { id: routineBundlesPath, filename: routineBundlesPath, loaded: true, exports: { getBundleComplement() { return null; }, BUNDLE_DISCOUNT_PERCENT: 10 } };
require.cache[trainingDataLoggerPath] = { id: trainingDataLoggerPath, filename: trainingDataLoggerPath, loaded: true, exports: { logTrainingExample() {} } };
require.cache[agentStatsPath] = { id: agentStatsPath, filename: agentStatsPath, loaded: true, exports: { recordTierUsage() {}, getStats() { return {}; } } };
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: { getCustomerHistory: () => [], updateOrderStatus: async () => {}, getCurrentOrderStatus: async () => null } };

delete require.cache[require.resolve('../src/bot/llmAgent')];
const llmAgent = require('../src/bot/llmAgent');
const { containsAny } = require('../src/utils/helpers');
const { ORDER_CANCELLATION_REQUEST_KEYWORDS } = require('../src/bot/prompts');

(async () => {
  // --- 1. Keyword coverage: the exact real missed phrasings now match ---
  {
    const realMissedPhrasings = ['هلغي الاوردر', 'هلغي الطلب', 'مش هستلم الاوردر', 'مش هاخد الطلب', 'مش هاخده الاوردر'];
    for (const phrase of realMissedPhrasings) {
      assert.ok(containsAny(phrase, ORDER_CANCELLATION_REQUEST_KEYWORDS), `expected "${phrase}" to now be recognized as a cancellation request`);
    }
    console.log('PASS: the exact real colloquial cancellation phrasings that were missed now match.');
  }

  // --- 2. The general safety net: even phrasing NO keyword list could
  //        anticipate ("م عوزاه") still escalates once the deflection would
  //        repeat, instead of looping forever. ---
  {
    const chatId = 'CANCEL_LOOP_REPRO@lid';
    conversationMemoryStub.updateSession(chatId, { orderPlaced: true, stage: 'AWAIT_ORDER_CONFIRMATION' });

    const r1 = await llmAgent.handleMessage({ chatId, phone: '1', text: 'شكرا م هستلم الاوردر', senderName: 'x' });
    assert.strictEqual(r1.reply, DEFLECTION_REPLY, 'expected the first turn to get the (unhelpful) model reply as-is — nothing to escalate on yet');

    const r2 = await llmAgent.handleMessage({ chatId, phone: '1', text: 'م عوزاه', senderName: 'x' });
    assert.notStrictEqual(r2.reply, DEFLECTION_REPLY, 'expected the SECOND turn (which would have repeated the identical deflection) to escalate instead');
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.humanHandover, true, 'expected a real human handoff to be triggered');
    assert.strictEqual(session.stage, 'CLOSED');
    console.log('PASS: repeated identical deflection on a confirmed order escalates to a human instead of looping forever.', r2.reply);
  }

  // --- 3. Sanity: the same repeated-reply pattern WITHOUT a confirmed order
  //        does not trigger this guard (scoped intentionally to orderPlaced) ---
  {
    const chatId = 'CANCEL_LOOP_NO_ORDER@lid';
    conversationMemoryStub.updateSession(chatId, { orderPlaced: false });
    await llmAgent.handleMessage({ chatId, phone: '2', text: 'عايزة اعرف اكتر', senderName: 'x' });
    const r2 = await llmAgent.handleMessage({ chatId, phone: '2', text: 'تمام', senderName: 'x' });
    assert.strictEqual(r2.reply, DEFLECTION_REPLY, 'expected no escalation when there is no confirmed order — this guard is intentionally scoped to the highest-stakes case');
    console.log('PASS: the guard is correctly scoped to orderPlaced sessions only, no false-positive escalation pre-order.');
  }

  console.log('\nALL POST-ORDER CANCELLATION LOOP TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
