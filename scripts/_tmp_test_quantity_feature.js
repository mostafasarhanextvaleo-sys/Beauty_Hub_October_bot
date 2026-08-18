// Regression test (not committed) for the 2026-08-19 Quantity feature
// (order_data.quantity end-to-end: llmSystemPrompt.js schema/prompt section,
// llmAgent.js resolveQuantity/computedProductTotal, googleSheets.js
// Confirmed_Orders column, invoiceGenerator.js line-item math,
// campaignWorker.js pass-through). Confirmed live (chatId
// 88876412584107@lid, phone 201055990502, Confirmed_Orders row 13): a
// 12-unit order was recorded at the single-unit price because there was no
// structured field to capture the count at all.
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

const PRODUCT = { id: 'C018', name: 'صن بلوك ديرماتيك كريم (Dermatique Sunblock Cream SPF 50)', category: 'skincare', price: '150', inStock: true };
let nextReply = null;
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: { async generateStructuredReply() { return nextReply; } } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: { async generateStructuredReply() { return null; } } };
require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: { async searchProducts() { return [PRODUCT]; } } };
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: { getById(id) { return id === 'C018' ? PRODUCT : null; }, getAllProducts() { return [PRODUCT]; } } };
require.cache[campaignKnowledgePath] = { id: campaignKnowledgePath, filename: campaignKnowledgePath, loaded: true, exports: { getActiveOffers() { return []; } } };
require.cache[routineBundlesPath] = { id: routineBundlesPath, filename: routineBundlesPath, loaded: true, exports: { getBundleComplement() { return null; }, BUNDLE_DISCOUNT_PERCENT: 10 } };
require.cache[trainingDataLoggerPath] = { id: trainingDataLoggerPath, filename: trainingDataLoggerPath, loaded: true, exports: { logTrainingExample() {} } };
require.cache[agentStatsPath] = { id: agentStatsPath, filename: agentStatsPath, loaded: true, exports: { recordTierUsage() {}, getStats() { return {}; } } };
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: { getCustomerHistory: () => [], updateOrderStatus: async () => {}, getCurrentOrderStatus: async () => null } };

delete require.cache[require.resolve('../src/bot/llmAgent')];
const llmAgent = require('../src/bot/llmAgent');

const BASE = {
  intent: 'ORDER_INTENT',
  mentioned_product_ids: ['C018'],
  price_quoted: null,
  routine_bundle_suggested_id: null,
  routine_bundle_price_quoted: null,
  human_handover: false,
  handover_reason: null,
};

(async () => {
  // --- 1. The exact real bug: 12 units confirmed in one turn must total 12x price, not 1x ---
  {
    const chatId = 'QTY_12@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT, shownProductIds: ['C018'] });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'منى', delivery_address: 'مدينة نصر', alt_phone: '01000000000', shipping_method: null, quantity: 12, confirmed: true },
      reply_text: 'تمام يا منى، هأكدلك 12 قطعة من صن بلوك ديرماتيك كريم.',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '201200000000', text: 'عايزة 12 قطعة وأكدي الطلب', senderName: 'منى' });
    assert.ok(result.orderHistoryEntry, 'expected an order history entry for a genuinely confirmed order');
    assert.strictEqual(result.orderHistoryEntry.price, '1800', `expected 12 x 150 = 1800, got ${result.orderHistoryEntry.price}`);
    assert.ok(result.logEntry.productName.includes('× 12'), `expected the product name to show the quantity, got "${result.logEntry.productName}"`);
    assert.strictEqual(result.logEntry.quantity, 12, 'expected the raw quantity threaded onto logEntry for campaignWorker/Confirmed_Orders');
    assert.ok(result.adminNotification.includes('الكمية: 12'), 'expected the admin ping to show the quantity line');
    console.log('PASS: a 12-unit confirmed order records the real 12x total, not the single-unit price.');
  }

  // --- 2. Default (no quantity ever stated) behaves exactly as before the feature: quantity 1, no quantity line ---
  {
    const chatId = 'QTY_DEFAULT@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT, shownProductIds: ['C018'] });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'سارة', delivery_address: 'التجمع الخامس', alt_phone: '01000000001', shipping_method: null, quantity: null, confirmed: true },
      reply_text: 'تمام يا سارة، هأكدلك الطلب.',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '201200000001', text: 'أكدي الطلب', senderName: 'سارة' });
    assert.strictEqual(result.orderHistoryEntry.price, '150', 'expected the bare single-unit price when no quantity was ever stated');
    assert.ok(!result.logEntry.productName.includes('×'), 'expected no quantity multiplier in the product name for a single unit');
    assert.strictEqual(result.logEntry.quantity, 1, 'expected quantity to default to 1');
    assert.ok(!result.adminNotification.includes('الكمية:'), 'expected no quantity line in the admin ping for a single unit');
    console.log('PASS: no-quantity-stated orders are completely unaffected (default 1, no quantity line/multiplier).');
  }

  // --- 3. Implausible quantity (misparse guard) is clamped, never trusted verbatim ---
  {
    const chatId = 'QTY_IMPLAUSIBLE@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT, shownProductIds: ['C018'] });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'ليلى', delivery_address: 'المعادي', alt_phone: '01000000002', shipping_method: null, quantity: 99999, confirmed: true },
      reply_text: 'تمام يا ليلى، هأكدلك الطلب.',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '201200000002', text: 'أكدي الطلب', senderName: 'ليلى' });
    assert.strictEqual(result.logEntry.quantity, 1, 'expected an implausible quantity (99999) to be clamped to the carried-over/default value, not trusted verbatim');
    assert.strictEqual(result.orderHistoryEntry.price, '150', 'expected the total to reflect the clamped quantity (1), not 99999x the price');
    console.log('PASS: an implausible order_data.quantity is clamped instead of producing an absurd invoiced total.');
  }

  // --- 4. Quantity carries over across turns exactly like other order_data fields ---
  {
    const chatId = 'QTY_CARRYOVER@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT, shownProductIds: ['C018'] });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'هدى', delivery_address: null, alt_phone: null, shipping_method: null, quantity: 3, confirmed: false },
      reply_text: 'تمام، محتاجة كمان العنوان.',
    };
    await llmAgent.handleMessage({ chatId, phone: '201200000003', text: 'عايزة 3 قطع', senderName: 'هدى' });
    nextReply = {
      ...BASE,
      order_data: { customer_name: 'هدى', delivery_address: 'الشيخ زايد', alt_phone: '01000000003', shipping_method: null, quantity: null, confirmed: true },
      reply_text: 'تمام يا هدى، هأكدلك الطلب.',
    };
    const result = await llmAgent.handleMessage({ chatId, phone: '201200000003', text: 'الشيخ زايد ورقم بديل 01000000003 وأكدي', senderName: 'هدى' });
    assert.strictEqual(result.logEntry.quantity, 3, 'expected the quantity given 1 turn earlier to carry over into the confirmed order');
    assert.strictEqual(result.orderHistoryEntry.price, '450', 'expected the carried-over quantity (3) x 150 = 450');
    console.log('PASS: a quantity stated on an earlier turn correctly carries over to the confirmed order.');
  }

  console.log('\nALL QUANTITY FEATURE TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
