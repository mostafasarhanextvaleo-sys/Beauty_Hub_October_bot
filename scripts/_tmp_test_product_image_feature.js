// Regression check (not committed) for the 2026-08-09 vision/product-photo
// features (llmAgent.js's handleProductImageRequest + the modelText/
// trimmedText split that keeps deterministic detectors immune to Vision-
// generated text). Stubs the same modules as
// scripts/_tmp_test_rejection_clears_product_regression.js, plus
// productMatcher (new: handleProductImageRequest re-reads the live catalog
// via productMatcher.getById rather than trusting the session's cached copy).
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
let lastContentsSeen = null;
const openaiServiceStub = {
  async generateStructuredReply({ contents }) {
    lastContentsSeen = contents;
    return nextOpenaiResponse;
  },
};
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: openaiServiceStub };
const geminiServiceStub = { async generateStructuredReply() { return null; } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: geminiServiceStub };

// Products live in BOTH productSearch (candidate search for the general LLM
// flow) and productMatcher (handleProductImageRequest's live-catalog re-read
// via getById) — kept as two separate stubs so the "re-read live data, don't
// trust the session's stale cached copy" behavior can actually be exercised
// (see test 5 below).
const PRODUCT_WITH_IMAGE = { id: 'P1', name: 'كريم ترطيب البشرة الجافة', category: 'skincare', price: '180', inStock: true, imageUrl: 'https://example.com/p1.jpg' };
const PRODUCT_NO_IMAGE = { id: 'P2', name: 'سيروم فيتامين سي', category: 'skincare', price: '220', inStock: true, imageUrl: '' };
let productMatcherCatalog = new Map([[PRODUCT_WITH_IMAGE.id, PRODUCT_WITH_IMAGE], [PRODUCT_NO_IMAGE.id, PRODUCT_NO_IMAGE]]);

let nextSearchResults = [];
const productSearchStub = { async searchProducts() { return nextSearchResults; } };
require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: productSearchStub };

const productMatcherStub = {
  getById(id) { return productMatcherCatalog.get(id) || null; },
  getAllProducts() { return [...productMatcherCatalog.values()]; },
};
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: productMatcherStub };

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
const { isProductImageRequest } = require('../src/bot/productImageRequestDetector');

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
  // --- 1. Pinned product WITH an image URL: sends productImage, no LLM call needed ---
  {
    const chatId = 'IMG_PINNED_WITH@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_WITH_IMAGE, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_WITH_IMAGE.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '1', text: 'ممكن صورة المنتج؟', senderName: 'x' });
    assert.ok(result.productImage, 'expected a productImage field to be returned');
    assert.strictEqual(result.productImage.url, PRODUCT_WITH_IMAGE.imageUrl, 'expected the EXACT sheet URL, nothing else');
    assert.strictEqual(result.productImage.productName, PRODUCT_WITH_IMAGE.name);
    assert.ok(result.reply.includes(PRODUCT_WITH_IMAGE.name), 'expected the reply to name the actual product');
    console.log('PASS: pinned product with an Image URL returns productImage with the exact sheet URL.');
  }

  // --- 2. Pinned product WITHOUT an image URL: graceful message, no productImage, never a broken link ---
  {
    const chatId = 'IMG_PINNED_NONE@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_NO_IMAGE, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_NO_IMAGE.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '2', text: 'وريني شكله', senderName: 'x' });
    assert.strictEqual(result.productImage, undefined, 'expected NO productImage field when the sheet cell is empty');
    assert.ok(result.reply.includes(PRODUCT_NO_IMAGE.name), 'expected the graceful message to still name the real product');
    assert.ok(!/https?:\/\//.test(result.reply), 'expected no raw URL/broken link leaked into the customer-facing reply');
    console.log('PASS: pinned product with NO Image URL gets a graceful message and no productImage field.');
  }

  // --- 3. Nothing pinned yet, but a fresh search finds a match: pins it AND sends the image ---
  {
    const chatId = 'IMG_FRESH_FOUND@lid';
    nextSearchResults = [PRODUCT_WITH_IMAGE];
    const result = await llmAgent.handleMessage({ chatId, phone: '3', text: 'عايزة صورة كريم الترطيب', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.ok(result.productImage, 'expected productImage on first-touch match too');
    assert.strictEqual(session.recommendedProduct.id, PRODUCT_WITH_IMAGE.id, 'expected the freshly-found product to get pinned for conversation continuity');
    assert.ok(session.shownProductIds.includes(PRODUCT_WITH_IMAGE.id));
    console.log('PASS: no product pinned yet, a fresh search match gets pinned and its image sent.');
  }

  // --- 4. Nothing pinned, nothing found: asks which product, never guesses ---
  {
    const chatId = 'IMG_NONE_FOUND@lid';
    nextSearchResults = [];
    const result = await llmAgent.handleMessage({ chatId, phone: '4', text: 'ممكن صورة', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(result.productImage, undefined);
    assert.strictEqual(session.recommendedProduct, undefined, 'expected nothing to get pinned when no product was actually found');
    console.log('PASS: no pinned/found product asks which one instead of guessing.', result.reply);
  }

  // --- 5. Live-catalog re-read: a staff member fills in the Image URL AFTER the product was pinned in-session ---
  {
    const chatId = 'IMG_LIVE_REREAD@lid';
    const staleSnapshot = { ...PRODUCT_NO_IMAGE }; // what the session cached back when it was pinned (no image yet)
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: staleSnapshot, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_NO_IMAGE.id] });
    // Staff just added the image URL in the Sheet — productMatcher's live catalog now reflects it.
    productMatcherCatalog.set(PRODUCT_NO_IMAGE.id, { ...PRODUCT_NO_IMAGE, imageUrl: 'https://example.com/p2-just-added.jpg' });

    const result = await llmAgent.handleMessage({ chatId, phone: '5', text: 'ممكن صورة المنتج', senderName: 'x' });
    assert.ok(result.productImage, 'expected the freshly-added image to be picked up, not the stale session snapshot');
    assert.strictEqual(result.productImage.url, 'https://example.com/p2-just-added.jpg');
    console.log('PASS: a staff edit to Image URL after pinning takes effect on the very next request (live re-read, not stale session cache).');
  }

  // --- 6. Collision-fix check: an incoming photo's Vision description (which
  //        will routinely contain the word "صورة" itself) must NEVER, by
  //        itself, trigger the outgoing product-photo path — only what the
  //        customer actually typed (imageContext must be kept separate from
  //        the deterministic detector's input, see llmAgent.js's trimmedText
  //        vs modelText split). ---
  {
    const chatId = 'IMG_VISION_NO_COLLISION@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_WITH_IMAGE, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_WITH_IMAGE.id] });
    nextOpenaiResponse = {
      ...VALID_BASE_RESPONSE,
      reply_text: 'شكلها فيها احمرار بسيط، ممكن يكون نوع حساسية 🌸 حابة أرشحلك حاجة لطيفة عليها؟',
    };
    // Customer sent a bare photo (no caption) of their skin — imageContext is
    // the Vision model's own description, which naturally uses "صورة".
    const result = await llmAgent.handleMessage({
      chatId,
      phone: '6',
      text: '',
      senderName: 'x',
      imageContext: 'الصورة بتوضح صورة قريبة لبشرة الوجه فيها بعض الاحمرار الخفيف حوالين الخدين.',
    });
    assert.strictEqual(result.productImage, undefined, 'a bare photo with no explicit request must NOT trigger the outgoing product-photo path');
    assert.ok(lastContentsSeen, 'expected the normal LLM tier to have been called instead');
    const lastUserTurn = lastContentsSeen[lastContentsSeen.length - 1];
    assert.strictEqual(lastUserTurn.role, 'user');
    assert.ok(lastUserTurn.content.includes('وصف تلقائي للصورة'), 'expected the Vision description to still reach the model as context');
    assert.ok(lastUserTurn.content.includes('احمرار'), 'expected the actual Vision description text to be included');
    console.log('PASS: an incoming photo\'s Vision description alone does not false-trigger the outgoing product-photo path, and still reaches the model as context.');
  }

  // --- 7. Sanity: an EXPLICIT typed request alongside a photo still correctly triggers the photo-send path ---
  {
    const chatId = 'IMG_VISION_EXPLICIT_REQUEST@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: PRODUCT_WITH_IMAGE, stage: 'RECOMMENDED', shownProductIds: [PRODUCT_WITH_IMAGE.id] });
    const result = await llmAgent.handleMessage({
      chatId,
      phone: '7',
      text: 'وريني صورة المنتج بقى',
      senderName: 'x',
      imageContext: 'الصورة بتوضح عبوة كريم بيضاء.',
    });
    assert.ok(result.productImage, 'expected an explicit customer request to still trigger the photo-send path even with imageContext present');
    console.log('PASS: an explicit typed photo request still triggers the send path regardless of imageContext.');
  }

  // --- 8. Detector unit sanity (kept here too, not just ad hoc) ---
  {
    assert.strictEqual(isProductImageRequest('ممكن صورة المنتج؟'), true);
    assert.strictEqual(isProductImageRequest('متتصوريش إنه غالي'), false, 'must not false-positive on تصور-family verbs');
    assert.strictEqual(isProductImageRequest('بشرتي دهنية وعندي حبوب'), false);
    // 2026-08-09 addition — confirmed live: bare plural "صور" (no ة) fell
    // through entirely before (only "صورة" was covered), landing in general
    // consultation which then hallucinated "no photos available".
    assert.strictEqual(isProductImageRequest('ممكن صور الصن بلوك إلى عندك'), true, 'bare plural صور must be caught (whole-word)');
    assert.strictEqual(isProductImageRequest('عندك صور؟'), true, 'trailing punctuation must not defeat the whole-word match');
    console.log('PASS: detector unit sanity checks.');
  }

  console.log('\nALL PRODUCT-IMAGE / VISION-COLLISION TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
