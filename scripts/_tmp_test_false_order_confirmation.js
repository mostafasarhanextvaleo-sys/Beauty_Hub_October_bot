// Regression test (not committed) for the 2026-08-09 P0 finding, confirmed
// live (chatId 260649351418038@lid, "ريماس اسلام"): she gave her full order
// details in one message, the model's reply_text said "هأكدلك الطلب دلوقتي"
// (reads as an immediate confirmation), but its own structured
// order_data.confirmed field was NOT true — so nothing was ever written to
// Order History/Confirmed_Orders, and she was never told anything was wrong.
// Verifies llmAgent.js's new claimsOrderConfirmationInReply backstop replaces
// the false claim with a real confirmation question instead.
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

const PRODUCT = { id: '19', name: 'صن بلوك جل ديرماتيك (Dermatique Sunblock Gel SPF 50)', category: 'skincare', price: '200£', inStock: true };
let nextReply = null;
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: { async generateStructuredReply() { return nextReply; } } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: { async generateStructuredReply() { return null; } } };
require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: { async searchProducts() { return [PRODUCT]; } } };
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: { getById(id) { return id === '19' ? PRODUCT : null; }, getAllProducts() { return [PRODUCT]; } } };
require.cache[campaignKnowledgePath] = { id: campaignKnowledgePath, filename: campaignKnowledgePath, loaded: true, exports: { getActiveOffers() { return []; } } };
require.cache[routineBundlesPath] = { id: routineBundlesPath, filename: routineBundlesPath, loaded: true, exports: { getBundleComplement() { return null; }, BUNDLE_DISCOUNT_PERCENT: 10 } };
require.cache[trainingDataLoggerPath] = { id: trainingDataLoggerPath, filename: trainingDataLoggerPath, loaded: true, exports: { logTrainingExample() {} } };
require.cache[agentStatsPath] = { id: agentStatsPath, filename: agentStatsPath, loaded: true, exports: { recordTierUsage() {}, getStats() { return {}; } } };
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: { getCustomerHistory: () => [], updateOrderStatus: async () => {}, getCurrentOrderStatus: async () => null } };

delete require.cache[require.resolve('../src/bot/llmAgent')];
const llmAgent = require('../src/bot/llmAgent');

const BASE = {
  intent: 'ORDER_INTENT',
  mentioned_product_ids: ['19'],
  price_quoted: null,
  routine_bundle_suggested_id: null,
  routine_bundle_price_quoted: null,
  human_handover: false,
  handover_reason: null,
};

(async () => {
  // --- 1. THE exact real bug: all fields present, confirmed:false, reply_text falsely claims confirmation ---
  {
    const chatId = 'FALSE_CONFIRM_1@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT, shownProductIds: ['19'] });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'ريماس اسلام', delivery_address: 'سيتي ستارز مدينه نصر بوابه 5', alt_phone: '01156979424', confirmed: false },
      reply_text: 'شكراً يا ريماس! هأكدلك الطلب دلوقتي: صن بلوك جل ديرماتيك بسعر 200 جنيه. لو في أي حاجة تانية محتاجاها، قوليلي!',
    };
    const result = await llmAgent.handleMessage({
      chatId,
      phone: '201272606464',
      text: 'ريماس اسلام\nسيتي ستارز مدينه نصر بوابه 5\n01272606464\n01156979424',
      senderName: 'x',
    });
    assert.ok(!/هأكدلك الطلب دلوقتي/.test(result.reply), 'expected the false confirmation claim to be stripped');
    assert.ok(result.reply.includes('البيانات دي صح؟'), 'expected a real confirmation question instead');
    assert.ok(result.reply.includes('ريماس اسلام'), 'expected the customer\'s actual name to still be reflected back');
    assert.strictEqual(result.orderHistoryEntry, undefined, 'expected NO order history entry to be created — nothing was actually confirmed');
    const session = conversationMemoryStub.getSession(chatId);
    assert.ok(!session.orderPlaced, 'expected orderPlaced to correctly stay falsy (never set true)');
    console.log('PASS: the exact real false-confirmation bug is caught and replaced with a genuine confirmation question.');
  }

  // --- 2. Sanity: a GENUINE confirmation (confirmed:true) is completely unaffected ---
  {
    const chatId = 'FALSE_CONFIRM_2@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT, shownProductIds: ['19'] });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'سارة', delivery_address: 'اكتوبر', alt_phone: '01000000000', confirmed: true },
      reply_text: 'تمام، طلبك اتسجل بنجاح! هيتم التواصل معاكي لتأكيد التوصيل قريب.',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '201000000001', text: 'تمام', senderName: 'x' });
    assert.ok(result.reply.includes('اتسجل بنجاح'), 'expected a genuine confirmation to pass through unchanged');
    assert.ok(result.orderHistoryEntry, 'expected a real order history entry for a genuine confirmation');
    console.log('PASS: a genuine order confirmation (confirmed:true) is completely unaffected by this fix.');
  }

  // --- 3. Sanity: reply_text that merely ASKS to confirm (not claiming it already happened) is unaffected ---
  {
    const chatId = 'FALSE_CONFIRM_3@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT, shownProductIds: ['19'] });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'منى', delivery_address: 'اكتوبر', alt_phone: '01000000002', confirmed: false },
      reply_text: 'تمام، خليني أتأكد من البيانات: الاسم منى، العنوان اكتوبر. البيانات دي صح؟',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '201000000002', text: 'منى\nاكتوبر\n01000000002', senderName: 'x' });
    assert.ok(result.reply.includes('البيانات دي صح؟'), 'expected the model\'s own already-correct confirmation question to pass through unchanged');
    console.log('PASS: a reply that correctly ASKS for confirmation (not claiming it already happened) is unaffected.');
  }

  console.log('\nALL FALSE-ORDER-CONFIRMATION TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
