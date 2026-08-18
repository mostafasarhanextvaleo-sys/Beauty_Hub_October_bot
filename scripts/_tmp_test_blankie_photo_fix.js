// Live-catalog verification for the 2026-08-12 fix: asking for "صورة بلانكي"
// (a photo of the Blankie brand) while a Dermatique product was still pinned
// from earlier in the conversation kept sending Dermatique's photo instead.
// Root cause: findNamedAlternativeProduct only ever considers same-category
// products that share name tokens WITH THE CURRENTLY PINNED product (real
// "variant siblings", e.g. a gel/cream pair of the SAME line) — "بلانكي"
// shares zero tokens with "ديرماتيك", so it never entered that search, and
// handleProductImageRequest silently kept the stale pin. Fix adds
// findNamedProductInFullCatalog as a second-stage fallback that searches the
// WHOLE catalog for a distinctive (rare-enough) token match. Runs against
// the REAL production Products sheet (productMatcher NOT stubbed), same
// reasoning as _tmp_test_product_image_variant_live.js — this specific class
// of bug has repeatedly only shown up against real catalog data, never
// synthetic fixtures. Does NOT hardcode product ids (the live catalog's id
// scheme has since changed from plain numbers to "C"-prefixed SKUs, which is
// why the older sibling test's hardcoded ids '18'/'19' now fail to resolve —
// a separate, pre-existing issue not touched by this fix) — looks products
// up by name instead.
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
  assert.strictEqual(productMatcher.getSource(), 'google-sheets');

  const allProducts = productMatcher.getAllProducts();
  const dermatique = allProducts.find((p) => /ديرماتيك غسول للبشرة الدهنية والمختلطة/.test(p.name || ''));
  const blankie = allProducts.find((p) => /بلانكي/.test(p.name || ''));
  assert.ok(dermatique, 'expected the real Dermatique cleanser (the exact product pinned in the live stuck session) to exist in the live catalog');
  assert.ok(blankie, 'expected the real Blankie product to exist in the live catalog');
  assert.ok(blankie.imageUrl, 'expected the Blankie product to have a valid Image URL in the Sheet (issue #2 in the report) — this run confirms the sheet data itself is fine');

  delete require.cache[require.resolve('../src/bot/llmAgent')];
  const llmAgent = require('../src/bot/llmAgent');

  // --- 1. The exact reported bug: pin is Dermatique, customer asks for "صورة بلانكي" ---
  {
    const chatId = 'BLANKIE_FIX_1@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: dermatique, stage: 'RECOMMENDED', shownProductIds: [dermatique.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '201098175119', text: 'صورة بلانكي', senderName: 'x' });
    console.log('Reply:', result.reply);
    assert.ok(result.productImage, 'expected a productImage to be sent');
    assert.strictEqual(result.productImage.url, blankie.imageUrl, 'expected Blankie\'s real sheet image URL, NOT Dermatique\'s');
    assert.strictEqual(result.productImage.productName, blankie.name);
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, blankie.id, 'expected the session to now be pinned to Blankie, not stay on the stale Dermatique pin');
    console.log('PASS: "صورة بلانكي" now correctly resolves to the real Blankie product, not the stale Dermatique pin.');
  }

  // --- 2. Regression guard: a generic word already known to be common across
  // many products ("كريم") must NOT be treated as a distinctive full-catalog
  // match — this is exactly the failure mode findNamedAlternativeProduct's
  // rejected approach #1 already warned about; the fix must not reintroduce it. ---
  {
    const chatId = 'BLANKIE_FIX_2_GENERIC@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: dermatique, stage: 'RECOMMENDED', shownProductIds: [dermatique.id] });
    await llmAgent.handleMessage({ chatId, phone: '2', text: 'عايزة صورة كريم', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, dermatique.id, 'a generic word ("كريم", common to 45 real product names) must not override the pin via the new full-catalog search');
    console.log('PASS: a generic, non-distinctive word does not false-trigger the new full-catalog match.');
  }

  // --- 3. Regression guard: existing behavior (vague re-ask keeps the pin) still holds. ---
  {
    const chatId = 'BLANKIE_FIX_3_VAGUE@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: dermatique, stage: 'RECOMMENDED', shownProductIds: [dermatique.id] });
    await llmAgent.handleMessage({ chatId, phone: '3', text: 'ممكن صورة تانية', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, dermatique.id, 'expected the pin to stay unchanged with no distinguishing word (pre-existing behavior, must not regress)');
    console.log('PASS: a vague re-ask with no distinguishing word still leaves the pin unchanged.');
  }

  console.log('\nALL LIVE-CATALOG BLANKIE-FIX TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
