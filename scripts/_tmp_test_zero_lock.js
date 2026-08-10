// Verifies the 2026-08-04 zero-lock/zero-handover safeguard in llmAgent.js:
// - noProgressTurns no longer forces a handover.
// - The 3rd consecutive identical message no longer forces a handover.
// - The model's own unconstrained human_handover=true (old CUSTOMER_REQUEST
//   self-trigger) is never trusted/ignored regardless of message content.
// - LONG_CONVERSATION_UNRESOLVED is only trusted once session.inboundMessageCount
//   has actually crossed the 60-message threshold — downgraded otherwise.
// - The deterministic escalationDetector explicit-request path is completely
//   unaffected and never even reaches the (stubbed) AI tier.
//
// Stubs only openaiService (so results are deterministic and no real API
// call/cost is involved) — everything else (conversationMemory, productSearch,
// campaignKnowledge, etc.) is stubbed minimally just to keep llmAgent.js's
// handleMessage runnable without network calls.
const assert = require('assert');

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const openaiServicePath = require.resolve('../src/services/openaiService');
const geminiServicePath = require.resolve('../src/services/geminiService');
const productSearchPath = require.resolve('../src/bot/productSearch');
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

let nextOpenaiResponse = null;
let openaiCallCount = 0;
const openaiServiceStub = {
  async generateStructuredReply() {
    openaiCallCount += 1;
    return nextOpenaiResponse;
  },
};
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: openaiServiceStub };
const geminiServiceStub = { async generateStructuredReply() { return null; } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: geminiServiceStub };

const productSearchStub = { async searchProducts() { return []; } };
require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: productSearchStub };
const campaignKnowledgeStub = { getActiveOffers() { return []; } };
require.cache[campaignKnowledgePath] = { id: campaignKnowledgePath, filename: campaignKnowledgePath, loaded: true, exports: campaignKnowledgeStub };
const routineBundlesStub = { getBundleComplement() { return null; }, BUNDLE_DISCOUNT_PERCENT: 10 };
require.cache[routineBundlesPath] = { id: routineBundlesPath, filename: routineBundlesPath, loaded: true, exports: routineBundlesStub };
const trainingDataLoggerStub = { logTrainingExample() {} };
require.cache[trainingDataLoggerPath] = { id: trainingDataLoggerPath, filename: trainingDataLoggerPath, loaded: true, exports: trainingDataLoggerStub };
const agentStatsStub = { recordTierUsage() {}, getStats() { return {}; } };
require.cache[agentStatsPath] = { id: agentStatsPath, filename: agentStatsPath, loaded: true, exports: agentStatsStub };
const googleSheetsStub = {
  getCustomerHistory: () => [],
  updateOrderStatus: async () => {},
  getCurrentOrderStatus: async () => null,
};
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

delete require.cache[require.resolve('../src/bot/llmAgent')];
const llmAgent = require('../src/bot/llmAgent');

const VALID_BASE_RESPONSE = {
  intent: 'GENERAL_QUESTION',
  mentioned_product_ids: [],
  price_quoted: null,
  routine_bundle_suggested_id: null,
  routine_bundle_price_quoted: null,
  order_data: { customer_name: null, delivery_address: null, alt_phone: null, confirmed: false },
  human_handover: false,
  handover_reason: null,
  reply_text: 'تمام، أقدر أساعدك في إيه؟',
};

(async () => {
  // --- 1. Explicit escalation request never reaches the (stubbed) AI tier ---
  {
    openaiCallCount = 0;
    const chatId = 'ZL_ESCALATION@lid';
    const result = await llmAgent.handleMessage({ chatId, phone: '1', text: 'عايز اتكلم مع حد', senderName: 'x' });
    assert.strictEqual(openaiCallCount, 0, 'expected the explicit escalation request to short-circuit before ever calling the AI tier');
    assert.ok(result.reply.includes('01018990503'), 'expected the deterministic escalation reply');
    console.log('PASS: explicit escalation request is fully unaffected and never reaches the LLM.');
  }

  // --- 2. noProgressTurns no longer forces a handover ---
  {
    const chatId = 'ZL_NOPROGRESS@lid';
    conversationMemoryStub.updateSession(chatId, { noProgressTurns: 5, orderData: { customerName: 'test' } });
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, intent: 'ORDER_INTENT', reply_text: 'تمام، محتاجة كمان تفاصيل؟' };
    const result = await llmAgent.handleMessage({ chatId, phone: '2', text: 'مش عارفة', senderName: 'x' });
    assert.ok(!result.logEntry.notes.includes('تحويل') , 'expected no handover-related note');
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.humanHandover, false, 'expected humanHandover to stay false despite high noProgressTurns');
    console.log('PASS: high noProgressTurns no longer forces a handover.');
  }

  // --- 3. 3rd consecutive identical message no longer forces a handover ---
  {
    const chatId = 'ZL_REPEAT@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, reply_text: 'ممكن توضحي أكتر؟' };
    await llmAgent.handleMessage({ chatId, phone: '3', text: 'تم', senderName: 'x' });
    await llmAgent.handleMessage({ chatId, phone: '3', text: 'تم', senderName: 'x' });
    const thirdResult = await llmAgent.handleMessage({ chatId, phone: '3', text: 'تم', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.humanHandover, false, 'expected no forced handover on the 3rd identical message');
    assert.ok(!thirdResult.reply.includes('فريقنا'), 'expected a normal reply, not the old hard-escalation canned message');
    console.log('PASS: repeating the same message 3x no longer forces a handover.');
  }

  // --- 4. Model's own unconstrained human_handover=true (old CUSTOMER_REQUEST) is ignored ---
  {
    const chatId = 'ZL_MODEL_CLAIM@lid';
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      human_handover: true,
      handover_reason: 'CUSTOMER_REQUEST',
      reply_text: 'تقدر تتواصل مع خدمة العملاء الحقيقيين مكالمة أو واتساب على الرقم ده: 01018990503',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '4', text: 'مش فاهمة حاجة خالص', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.humanHandover, false, 'expected the model\'s own CUSTOMER_REQUEST claim to be ignored');
    assert.ok(!result.reply.includes('01018990503'), 'expected the hand-off reply text to be replaced with a normal consultation fallback');
    console.log('PASS: the model\'s own unconstrained human_handover/CUSTOMER_REQUEST claim is ignored and its reply text is downgraded.');
  }

  // --- 5. LONG_CONVERSATION_UNRESOLVED downgraded when count hasn't crossed 60 ---
  {
    const chatId = 'ZL_LONGCONV_TOO_EARLY@lid';
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      human_handover: true,
      handover_reason: 'LONG_CONVERSATION_UNRESOLVED',
      reply_text: 'المحادثة استمرت لفترة طويلة، حابين نتأكد إننا بنساعدك بأفضل شكل ممكن — فريقنا هيتواصل معاكي مباشرة دلوقتي 🌸',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '5', text: 'حاجة عادية', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.humanHandover, false, 'expected LONG_CONVERSATION_UNRESOLVED to be downgraded when inboundMessageCount is nowhere near 60');
    assert.ok(!result.reply.includes('استمرت لفترة طويلة'), 'expected the hand-off reply text to be replaced');
    console.log('PASS: LONG_CONVERSATION_UNRESOLVED is downgraded when the message count has not actually crossed the threshold.');
  }

  // --- 6. LONG_CONVERSATION_UNRESOLVED trusted once count has actually crossed 60 ---
  {
    const chatId = 'ZL_LONGCONV_VALID@lid';
    conversationMemoryStub.updateSession(chatId, { inboundMessageCount: 61 });
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      human_handover: true,
      handover_reason: 'LONG_CONVERSATION_UNRESOLVED',
      reply_text: 'المحادثة استمرت لفترة طويلة، حابين نتأكد إننا بنساعدك بأفضل شكل ممكن — فريقنا هيتواصل معاكي مباشرة دلوقتي 🌸',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '6', text: 'لسه المشكلة موجودة ومحتاجة حد يساعدني', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.humanHandover, true, 'expected LONG_CONVERSATION_UNRESOLVED to be trusted once the count has actually crossed 60');
    assert.ok(result.reply.includes('استمرت لفترة طويلة'), 'expected the verified hand-off reply to reach the customer');
    console.log('PASS: LONG_CONVERSATION_UNRESOLVED is trusted once the message count has genuinely crossed 60.');
  }

  console.log('\nALL ZERO-LOCK SAFEGUARD TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
