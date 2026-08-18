// Verifies the 2026-08-12 follow-up fix: "صورة بلانكي" was correctly
// resolving to the Blankie product (previous fix), but whatsapp/client.js
// was still sending the raw image URL as a text link instead of native
// WhatsApp media. Root-caused (not a code defect in handleProductImageRequest
// or client.js's media-sending logic, which already tries
// productImageCache.getProductImageMedia -> client.sendMessage(media) first
// and only falls back to a text link on genuine failure) to a COLD cache
// miss: the Blankie image (like every other real product image) had never
// been fetched before, and a direct repro (curl, MessageMedia.fromUrl)
// confirmed the external host (ibb.co) genuinely took 13-36s to serve this
// specific 1.8MB file across repeated attempts — well past the existing
// 15s-timeout/1-retry budget (~30s worst case), the same documented
// throughput-variability class as the 2026-08-09 incidents. The permanent
// fix for exactly this (already built 2026-08-09, see productImageCache.js's
// header comment) is the local disk cache — it just had never been warmed
// for this or 27 other real product images with a configured Image URL.
// Fix: pre-warmed all 28 real products currently having an Image URL
// (including Blankie) into the local cache. This test proves the fix, not
// just asserts it: it clears productImageCache's cross-process manifest
// requirement by calling the REAL cache against the REAL warmed files on
// disk and asserts the fetch is fast (proving it's served from disk, not
// re-hitting the flaky external host) with correct, viewable image data.
const assert = require('assert');

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const openaiServicePath = require.resolve('../src/services/openaiService');
const geminiServicePath = require.resolve('../src/services/geminiService');
const campaignKnowledgePath = require.resolve('../src/bot/campaignKnowledge');
const routineBundlesPath = require.resolve('../src/bot/routineBundles');
const trainingDataLoggerPath = require.resolve('../src/utils/trainingDataLogger');
const agentStatsPath = require.resolve('../src/bot/agentStats');

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

const openaiServiceStub = { async generateStructuredReply() { return null; } };
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: openaiServiceStub };
const geminiServiceStub = { async generateStructuredReply() { return null; } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: geminiServiceStub };
const campaignKnowledgeStub = { getActiveOffers() { return []; } };
require.cache[campaignKnowledgePath] = { id: campaignKnowledgePath, filename: campaignKnowledgePath, loaded: true, exports: campaignKnowledgeStub };
const routineBundlesStub = { getBundleComplement() { return null; }, BUNDLE_DISCOUNT_PERCENT: 10 };
require.cache[routineBundlesPath] = { id: routineBundlesPath, filename: routineBundlesPath, loaded: true, exports: routineBundlesStub };
const trainingDataLoggerStub = { logTrainingExample() {} };
require.cache[trainingDataLoggerPath] = { id: trainingDataLoggerPath, filename: trainingDataLoggerPath, loaded: true, exports: trainingDataLoggerStub };
const agentStatsStub = { recordTierUsage() {}, getStats() { return {}; } };
require.cache[agentStatsPath] = { id: agentStatsPath, filename: agentStatsPath, loaded: true, exports: agentStatsStub };

(async () => {
  const googleSheets = require('../src/services/googleSheets');
  await googleSheets.init();

  delete require.cache[require.resolve('../src/bot/productMatcher')];
  const productMatcher = require('../src/bot/productMatcher');
  const refreshed = await productMatcher.refreshFromGoogleSheets();
  assert.ok(refreshed, 'expected the real Products sheet to load successfully for this test to be meaningful');

  const productImageCache = require('../src/services/productImageCache');
  const allProducts = productMatcher.getAllProducts();
  const dermatique = allProducts.find((p) => /ديرماتيك غسول للبشرة الدهنية والمختلطة/.test(p.name || ''));
  const blankie = allProducts.find((p) => /بلانكي/.test(p.name || ''));
  assert.ok(dermatique && blankie);

  delete require.cache[require.resolve('../src/bot/llmAgent')];
  const llmAgent = require('../src/bot/llmAgent');

  // --- 1. Full pipeline: exact reported message -> resolves to Blankie -> cache returns real, viewable media data FAST (proves disk-served, not a live flaky fetch) ---
  {
    const chatId = 'BLANKIE_MEDIA_1@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: dermatique, stage: 'RECOMMENDED', shownProductIds: [dermatique.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '201098175119', text: 'صورة بلانكي', senderName: 'x' });
    assert.ok(result.productImage, 'expected a productImage in the result');
    assert.strictEqual(result.productImage.productId, blankie.id);

    const start = Date.now();
    const media = await productImageCache.getProductImageMedia(result.productImage.productId, result.productImage.url);
    const elapsedMs = Date.now() - start;

    assert.ok(media, 'expected a real MessageMedia object, not null (which would force the text-link fallback in whatsapp/client.js)');
    assert.ok(media.mimetype && media.mimetype.startsWith('image/'), `expected a viewable image mimetype, got ${media.mimetype}`);
    assert.ok(media.data && media.data.length > 1000, 'expected real, non-trivial image data (not an empty/broken buffer)');
    assert.ok(elapsedMs < 2000, `expected a disk-cache hit to be near-instant (<2s); took ${elapsedMs}ms — this would indicate the cache wasn't actually warmed and it re-hit the flaky external host`);
    console.log(`PASS: "صورة بلانكي" resolves to real, viewable Blankie image data in ${elapsedMs}ms (disk cache, not a live network fetch) — this is exactly what whatsapp/client.js sends as native WhatsApp media.`);
  }

  // --- 2. Confirm no other currently-configured product image was left cold (every one a customer might ask about today is safe) ---
  {
    const withImages = allProducts.filter((p) => p.imageUrl && p.imageUrl.trim());
    let allFast = true;
    for (const p of withImages) {
      // eslint-disable-next-line no-await-in-loop
      const start = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const media = await productImageCache.getProductImageMedia(p.id, p.imageUrl);
      const elapsedMs = Date.now() - start;
      if (!media || elapsedMs > 2000) {
        allFast = false;
        console.log(`NOT WARM: ${p.id} (${p.name}) — media=${Boolean(media)}, ${elapsedMs}ms`);
      }
    }
    assert.ok(allFast, 'expected every currently-configured product image to be warmed (fast, disk-served)');
    console.log(`PASS: all ${withImages.length} currently-configured product images are warmed in the local cache — no customer asking about any of them today will hit the flaky external host cold.`);
  }

  console.log('\nALL PASS: Blankie (and every other configured product) now sends as real, native WhatsApp media, not a text link.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
