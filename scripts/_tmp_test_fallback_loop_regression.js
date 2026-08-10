// Regression check (not committed) for the 2026-08-09 P0 fix: a downgraded
// SPECIALIST_REFERRAL/CUSTOMER_REQUEST/LONG_CONVERSATION_UNRESOLVED used to
// send the byte-identical NORMAL_CONSULTATION_FALLBACK sentence forever, since
// that sentence gets saved into session.llm.history and re-primes the same
// misclassification next turn — confirmed live (chatId 22695194415336@lid),
// a customer got it 3x in a row and never converted. This verifies the new
// loop guard in llmAgent.js: the 1st downgrade in a row still gets the normal
// redirect, but a 2nd CONSECUTIVE one escalates to a human instead of
// repeating it, and the counter resets whenever an intervening turn doesn't
// downgrade — so an isolated redirect elsewhere in a long conversation never
// wrongly counts toward a later, unrelated one.
//
// Stubs only openaiService (deterministic, no real API call/cost) — same
// pattern as scripts/_tmp_test_zero_lock.js.
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
const openaiServiceStub = { async generateStructuredReply() { return nextOpenaiResponse; } };
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

// The model wrongly asserting SPECIALIST_REFERRAL on a message with no real
// clinical keyword — exactly the over-caution case the deterministic
// hasClinicalSeverityKeyword guard in llmAgent.js catches and downgrades.
const FALSE_REFERRAL_RESPONSE = {
  ...VALID_BASE_RESPONSE,
  human_handover: true,
  handover_reason: 'SPECIALIST_REFERRAL',
  reply_text: 'حالتك محتاجة متابعة من فريقنا المتخصص، فريق Beauty Hub October هيتابع معاكي فورًا 🌸',
};

const NORMAL_FALLBACK_TEXT =
  'تمام، ده موضوع عادي جدًا وهساعدك فيه زي أي استشارة تانية 💛 لو حابة تضيفي أي تفاصيل زي روتين العناية الحالي أو الميزانية التقريبية، هقدر أرشحلك أنسب منتج من عندنا فورًا.';

(async () => {
  // --- 1. First downgrade in a session still gets the normal one-time redirect ---
  {
    const chatId = 'FB_FIRST@lid';
    nextOpenaiResponse = FALSE_REFERRAL_RESPONSE;
    const result = await llmAgent.handleMessage({ chatId, phone: '1', text: 'خطوط وترهلات وانتفاخ تحت العين', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(result.reply, NORMAL_FALLBACK_TEXT, 'expected the normal one-time redirect on the 1st downgrade');
    assert.strictEqual(session.humanHandover, false, 'expected no handover yet on the 1st downgrade');
    assert.strictEqual(session.consecutiveFallbackDowngrades, 1, 'expected the counter to be at 1 after the 1st downgrade');
    console.log('PASS: 1st consecutive downgrade sends the normal redirect, no handover.');
  }

  // --- 2. Second CONSECUTIVE downgrade escalates instead of repeating ---
  {
    const chatId = 'FB_SECOND@lid';
    nextOpenaiResponse = FALSE_REFERRAL_RESPONSE;
    await llmAgent.handleMessage({ chatId, phone: '2', text: 'خطوط وترهلات', senderName: 'x' });
    nextOpenaiResponse = FALSE_REFERRAL_RESPONSE;
    const result = await llmAgent.handleMessage({ chatId, phone: '2', text: 'الميزانية 500', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.notStrictEqual(result.reply, NORMAL_FALLBACK_TEXT, 'expected the 2nd consecutive downgrade to NOT repeat the identical sentence');
    assert.strictEqual(session.humanHandover, true, 'expected the 2nd consecutive downgrade to trigger a real human handover');
    assert.ok(session.humanHandoffAt, 'expected the human-handoff cooldown timestamp to be set');
    assert.strictEqual(session.consecutiveFallbackDowngrades, 0, 'expected the counter to reset once escalation actually fires');
    console.log('PASS: 2nd consecutive downgrade escalates to a human instead of repeating the fallback sentence.');
  }

  // --- 3. A clean (non-downgrade) turn in between resets the streak ---
  {
    const chatId = 'FB_RESET@lid';
    nextOpenaiResponse = FALSE_REFERRAL_RESPONSE;
    await llmAgent.handleMessage({ chatId, phone: '3', text: 'خطوط وترهلات', senderName: 'x' });
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, reply_text: 'تمام، تحبي تقوليلي نوع بشرتك؟' };
    await llmAgent.handleMessage({ chatId, phone: '3', text: 'مختلطة', senderName: 'x' });
    nextOpenaiResponse = FALSE_REFERRAL_RESPONSE;
    const result = await llmAgent.handleMessage({ chatId, phone: '3', text: 'حبوب برضو', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(result.reply, NORMAL_FALLBACK_TEXT, 'expected the normal redirect again since the streak was broken by a clean turn');
    assert.strictEqual(session.humanHandover, false, 'expected no handover — the intervening clean turn should have reset the streak');
    console.log('PASS: an intervening clean turn resets the consecutive-downgrade streak.');
  }

  // --- 4. A genuine SPECIALIST_REFERRAL (real clinical keyword) is completely unaffected ---
  {
    const chatId = 'FB_REAL_REFERRAL@lid';
    nextOpenaiResponse = FALSE_REFERRAL_RESPONSE; // same structured output, but now a real keyword is present
    const result = await llmAgent.handleMessage({ chatId, phone: '4', text: 'حبوب كيسية ملتهبة أوي ووجعاني جدًا', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.ok(result.reply.includes('محتاجة متابعة من فريقنا المتخصص'), 'expected the real SPECIALIST_REFERRAL reply to reach the customer unmodified');
    assert.strictEqual(session.humanHandover, true, 'expected a genuine referral to hand over immediately, on the 1st turn');
    console.log('PASS: a genuine clinical-keyword SPECIALIST_REFERRAL still hands over normally on the very first turn.');
  }

  console.log('\nALL FALLBACK-LOOP GUARD TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
