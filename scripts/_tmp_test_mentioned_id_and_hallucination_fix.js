// Regression tests (not committed) for the 2026-08-09 fixes to two bugs
// surfaced by live testing of the product-photo feature, chatId
// 22299554107457@lid:
// 1. mentioned_product_ids[0] didn't always match what reply_text actually
//    discussed (reply said "cream", array had "gel" first) — the naive pin
//    logic blindly trusted array order, silently pinning the wrong product.
//    Previously low-stakes (only affected later nudges); now directly wrong
//    since it decides which real photo gets sent.
// 2. The LLM claimed "مفيش صورة متاحة" (no photo available) on its own
//    initiative TWICE, even after the rule-8-ب prompt hardening shipped —
//    same "prompt-only isn't 100% reliable" pattern documented elsewhere in
//    this file for SPECIALIST_REFERRAL, now given the same two-layer fix
//    (prompt rule + deterministic backstop).
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

let nextOpenaiResponse = null;
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: { async generateStructuredReply() { return nextOpenaiResponse; } } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: { async generateStructuredReply() { return null; } } };

const CREAM = { id: '18', name: 'صن بلوك ديرماتيك SPF 50 (Dermatique Sunblock SPF 50)', category: 'skincare', price: '200', inStock: true, imageUrl: 'https://example.com/cream.png' };
const GEL = { id: '19', name: 'صن بلوك جل ديرماتيك (Dermatique Sunblock Gel SPF 50)', category: 'skincare', price: '210', inStock: true, imageUrl: 'https://example.com/gel.png' };

require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: { async searchProducts() { return [CREAM, GEL]; } } };
require.cache[productMatcherPath] = {
  id: productMatcherPath,
  filename: productMatcherPath,
  loaded: true,
  exports: { getById(id) { return id === '18' ? CREAM : id === '19' ? GEL : null; }, getAllProducts() { return [CREAM, GEL]; } },
};
require.cache[campaignKnowledgePath] = { id: campaignKnowledgePath, filename: campaignKnowledgePath, loaded: true, exports: { getActiveOffers() { return []; } } };
require.cache[routineBundlesPath] = { id: routineBundlesPath, filename: routineBundlesPath, loaded: true, exports: { getBundleComplement() { return null; }, BUNDLE_DISCOUNT_PERCENT: 10 } };
require.cache[trainingDataLoggerPath] = { id: trainingDataLoggerPath, filename: trainingDataLoggerPath, loaded: true, exports: { logTrainingExample() {} } };
require.cache[agentStatsPath] = { id: agentStatsPath, filename: agentStatsPath, loaded: true, exports: { recordTierUsage() {}, getStats() { return {}; } } };
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: { getCustomerHistory: () => [], updateOrderStatus: async () => {}, getCurrentOrderStatus: async () => null } };

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
  // --- 1. THE exact real bug: mentioned_product_ids lists gel first, but
  //        reply_text clearly discusses the cream by name — must pin cream.
  //        (In practice the pre-existing upstream filter in
  //        validateModelOutput, productNameAppearsInReply, already drops gel
  //        here since its name isn't in reply_text at all — leaving a single
  //        survivor. This end-to-end check confirms the real reported
  //        scenario resolves correctly regardless of which layer does the
  //        work; pickPrimaryMentionedProduct's own reordering logic only
  //        engages when 2+ ids survive that upstream filter.) ---
  {
    const chatId = 'MENTION_ORDER_1@lid';
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      mentioned_product_ids: [GEL.id, CREAM.id],
      reply_text: 'صن بلوك ديرماتيك SPF 50 متاح بسعر 200 جنيه. لو حابة تحجزيه، قوليلي بس!',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '1', text: 'محتاج صن بلوك', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, CREAM.id, 'expected the pin to follow what reply_text actually discussed (cream), not the array order (gel first)');
    console.log('PASS: mentioned_product_ids order mismatch with reply_text is corrected — pins the product reply_text actually discussed.');
  }

  // --- 2. Reverse case: gel genuinely discussed, gel listed first — must stay gel (no incorrect override) ---
  {
    const chatId = 'MENTION_ORDER_2@lid';
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      mentioned_product_ids: [GEL.id, CREAM.id],
      reply_text: 'صن بلوك جل ديرماتيك متاح بسعر 210 جنيه. لو حابة تحجزيه، قوليلي بس!',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '2', text: 'محتاج الجل', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, GEL.id, 'expected gel to stay pinned when reply_text genuinely discusses it');
    console.log('PASS: a genuinely correct array order (matching reply_text) is left unchanged.');
  }

  // --- 3. Ambiguous/no-signal case (neither product name appears in
  //        reply_text AT ALL): the pre-existing upstream filter in
  //        validateModelOutput (productNameAppearsInReply) already drops any
  //        mentioned id whose name isn't found in reply_text, BEFORE
  //        pickPrimaryMentionedProduct ever runs — so both ids get dropped
  //        here and nothing gets pinned. This is pre-existing behavior
  //        (unrelated to this fix), asserted here only to document that this
  //        fix never fires without at least one upstream-confirmed id to
  //        choose among — it can only ever reorder, never invent a pin from
  //        nothing. ---
  {
    const chatId = 'MENTION_ORDER_3@lid';
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      mentioned_product_ids: [GEL.id, CREAM.id],
      reply_text: 'تمام، هل ممكن تقوليلي نوع بشرتك عشان أرشحلك حاجة مناسبة؟',
    };
    await llmAgent.handleMessage({ chatId, phone: '3', text: 'عايزة حاجة للشمس', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.ok(!session.recommendedProduct, 'expected no pin at all when neither product is actually named in reply_text (pre-existing upstream filter, both ids dropped)');
    console.log('PASS: neither product named in reply_text means nothing gets pinned (pre-existing upstream filter, confirmed still intact).');
  }

  // --- 4. Single mentioned id (the overwhelmingly common case): completely unaffected ---
  {
    const chatId = 'MENTION_ORDER_4@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, mentioned_product_ids: [CREAM.id], reply_text: 'صن بلوك ديرماتيك SPF 50 متاح.' };
    await llmAgent.handleMessage({ chatId, phone: '4', text: 'محتاج صن بلوك', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, CREAM.id);
    console.log('PASS: the single-mentioned-id case (by far the most common) is completely unaffected.');
  }

  // --- 5. Hallucination backstop: the model claims "no photo available" unprompted — must be overridden ---
  {
    const chatId = 'HALLUCINATION_1@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: CREAM });
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      reply_text: 'صن بلوك ديرماتيك SPF 50 هو كريم واقٍ من الشمس، بس للأسف مفيش صورة متاحة ليه في الوقت الحالي.',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '5', text: 'ممكن الكريم', senderName: 'x' });
    assert.ok(!result.reply.includes('مفيش صورة'), 'expected the hallucinated photo-unavailability claim to be stripped');
    console.log('PASS: hallucinated "no photo available" claim is caught and replaced.', result.reply);
  }

  // --- 6. Normal replies that happen to contain "صور" in an unrelated sense are NOT falsely caught ---
  {
    const chatId = 'HALLUCINATION_2@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, reply_text: 'تقدري تتصوري الفرق بعد الاستخدام بأسبوعين، البشرة بتبقى أنعم كتير 🌸' };
    const result = await llmAgent.handleMessage({ chatId, phone: '6', text: 'هل بيفرق فعلا', senderName: 'x' });
    assert.ok(result.reply.includes('تتصوري'), 'expected an unrelated reply (imagine/visualize, not photo availability) to pass through untouched');
    console.log('PASS: an unrelated use of a similar root word is not falsely caught by the hallucination guard.');
  }

  console.log('\nALL MENTIONED-ID-ORDER / HALLUCINATION-BACKSTOP TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
