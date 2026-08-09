// Regression check (not committed) for the 2026-08-09 P1 fix: a customer
// explicitly rejecting/correcting the currently pinned recommendedProduct
// used to leave it pinned anyway — confirmed live (chatId 165618334609589@lid),
// a customer said "انا لم اسأل على اى منتجات لانفنتى" ("I never asked about
// any Infinity products") and cartRecovery.js's automated nudges still
// re-pitched the exact rejected product twice afterward, with a "still
// holding this for you" framing. Verifies llmAgent.js now clears
// recommendedProduct on intent==='REJECTION' (already part of the validated
// schema — the model already classifies this correctly, it just wasn't
// acted on before), which also naturally drops the session out of
// cartRecovery's NUDGE_ELIGIBLE_STAGES until a fresh product is recommended.
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
  isDeliveryFeedbackExpired() { return false; },
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

let nextOpenaiResponse = null;
const openaiServiceStub = { async generateStructuredReply() { return nextOpenaiResponse; } };
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: openaiServiceStub };
const geminiServiceStub = { async generateStructuredReply() { return null; } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: geminiServiceStub };

// Both test products always in the candidate pool (this test is about
// applyValidatedOutput's rejection-clearing logic, not candidate search/
// relevance — a real turn would only surface the currently-relevant subset).
const PRODUCT_A = { id: 'A1', name: 'إنفنتي كريم تفتيح', category: 'skincare', price: '190', inStock: true };
const PRODUCT_B = { id: 'B2', name: 'دير كريم تفتيح', category: 'skincare', price: '230', inStock: true };
const productSearchStub = { async searchProducts() { return [PRODUCT_A, PRODUCT_B]; } };
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
delete require.cache[require.resolve('../src/bot/cartRecovery')];
const { NUDGE_ELIGIBLE_STAGES } = (() => {
  // cartRecovery.js doesn't export NUDGE_ELIGIBLE_STAGES today — read the
  // module source's own STAGES membership indirectly isn't possible without
  // exporting it, so this test re-derives the same set from conversationMemory's
  // STAGES the module itself uses, matching cartRecovery.js's own definition
  // (RECOMMENDED, AWAIT_ORDER_DETAILS, AWAIT_ORDER_CONFIRMATION) for the
  // assertion below rather than requiring an export change just for a test.
  return { NUDGE_ELIGIBLE_STAGES: new Set(['RECOMMENDED', 'AWAIT_ORDER_DETAILS', 'AWAIT_ORDER_CONFIRMATION']) };
})();

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
  // --- 1. Sanity: seed a pinned product directly (isolates this test to
  //        applyValidatedOutput's rejection-clearing logic specifically,
  //        rather than re-testing product-matching/candidate-selection,
  //        which is stubbed out here and already covered elsewhere) ---
  {
    const chatId = 'RJ_PIN@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_A, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_A.id] });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, PRODUCT_A.id, 'sanity: product A is pinned');
    console.log('PASS: sanity — product A is pinned before the rejection turn.');
  }

  // --- 2. REJECTION with no product re-mentioned clears the pin and drops stage out of nudge eligibility ---
  {
    const chatId = 'RJ_CLEAR@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_A, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_A.id] });
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      intent: 'REJECTION',
      mentioned_product_ids: [],
      reply_text: 'حاضر، معلش! تحبي تقوليلي عايزة إيه بالظبط؟',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '2', text: 'انا لم اسأل على اى منتجات لانفنتى', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct, null, 'expected the rejected product to be unpinned');
    assert.notStrictEqual(session.stage, 'RECOMMENDED', 'expected stage to fall back off RECOMMENDED once unpinned');
    assert.ok(!NUDGE_ELIGIBLE_STAGES.has(session.stage), 'expected the session to no longer be cart-recovery nudge-eligible');
    console.log('PASS: REJECTION with no product re-mentioned clears the pin and exits nudge eligibility.', result.reply);
  }

  // --- 3. REJECTION that immediately pivots to a NEW product pins the new one, not null ---
  {
    const chatId = 'RJ_PIVOT@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_A, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_A.id] });
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      intent: 'REJECTION',
      mentioned_product_ids: [PRODUCT_B.id],
      reply_text: `مفيش مشكلة! تحبي ${PRODUCT_B.name} بـ${PRODUCT_B.price} جنيه بدل منه؟`,
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '3', text: 'لأ مش عايزة ده، عايزة التاني', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.ok(session.recommendedProduct, 'expected a product to still be pinned');
    assert.strictEqual(session.recommendedProduct.id, PRODUCT_B.id, 'expected the NEW product to be pinned, not left null');
    assert.strictEqual(session.stage, 'RECOMMENDED', 'expected stage to stay RECOMMENDED for the new pin');
    console.log('PASS: REJECTION that pivots to a new product pins the new one.', result.reply);
  }

  // --- 4. Non-REJECTION intent with the same product still mentioned is completely unaffected ---
  {
    const chatId = 'RJ_UNAFFECTED@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_A, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_A.id] });
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      intent: 'PRICE_QUESTION',
      mentioned_product_ids: [PRODUCT_A.id],
      reply_text: `${PRODUCT_A.name} سعره ${PRODUCT_A.price} جنيه.`,
    };
    await llmAgent.handleMessage({ chatId, phone: '4', text: 'بكام؟', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, PRODUCT_A.id, 'expected the pin to be completely unaffected by a non-rejection turn');
    console.log('PASS: a normal (non-rejection) turn about the same product leaves the pin unaffected.');
  }

  console.log('\nALL REJECTION-CLEARS-PRODUCT TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
