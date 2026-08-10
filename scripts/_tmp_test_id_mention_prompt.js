// Regression tests (not committed) for the 2026-08-10 Product ID/SKU
// recognition feature: productIdDetector.js (pure text extraction) +
// productMatcher.js's findByIdCandidate (resolution against the real live
// catalog) + llmAgent.js's idMentionProduct wiring.
//
// IMPORTANT catalog-shape correction made while writing this test: the
// local products.json fallback (788 products, plain sequential ids "1".."788",
// no letter prefix) is STALE. The REAL live Products sheet (source of truth,
// confirmed via productMatcher.refreshFromGoogleSheets() against the actual
// Google Sheets API) has already been restructured to 270 products with a
// "C001".."C270" letter-prefixed scheme — e.g. the sunblock cream/gel pair
// used throughout this codebase's prior test history is now C018/C019, not
// 18/19. This IS the "letter prefix + digits" shape productIdDetector.js's
// own comments assumed all along, so the reconstruction logic in
// findByIdCandidate is live and exercised in production, not dead code.
const assert = require('assert');

// --- Part 1: productIdDetector.js — pure text extraction, no catalog involved ---
const { extractProductIdCandidates } = require('../src/bot/productIdDetector');

{
  const cases = [
    // SKU-shaped tokens — no extra context required
    { text: 'عايزة اطلب C102 من فضلك', expect: ['C102'] },
    { text: 'المنتج c-102 متاح؟', expect: ['C102'] },
    { text: 'C 102', expect: ['C102'] },
    // Explicit markers required for bare numbers
    { text: 'كود 45', expect: ['45'] },
    { text: 'المنتج رقم 45', expect: ['45'] },
    { text: 'رقم المنتج 45', expect: ['45'] },
    { text: '#45', expect: ['45'] },
    { text: 'SKU: 45', expect: ['45'] },
    // Negative: bare "رقم" alone (picking an item off a numbered list) must NOT be read as an id
    { text: 'رقم ٣', expect: [] },
    { text: 'عايزة رقم 3 من اللي فاتوا', expect: [] },
    // Negative: ordinary Arabic size text must not false-positive as a SKU (no Latin letters to collide)
    { text: 'حجم 100 مل', expect: [] },
    // KNOWN GAP, confirmed live, not yet fixed: SKU_TOKEN_REGEX's own comment
    // claims "a spec (SPF 50) never sticks LATIN letters directly onto a
    // number this way" — that's false. A short Latin abbreviation directly
    // followed by digits (SPF 50, Q10, UV400 — all real skincare-label
    // vocabulary) matches the exact same shape as a real SKU and gets
    // extracted as a false-positive candidate. Currently harmless in
    // production because the real catalog's letter prefix is always "C"
    // (confirmed: all 270 live ids), so "SPF50"/"Q10" never coincidentally
    // collides with a real id and is silently dropped by findByIdCandidate's
    // exact-match requirement — but this is incidental, not by design, and
    // is worth knowing about if the catalog ever adds a "SPF"- or "Q"-
    // prefixed SKU series.
    { text: 'SPF 50', expect: ['SPF50'] },
    { text: 'كريم فيه Q10', expect: ['Q10'] },
  ];
  for (const { text, expect } of cases) {
    const got = extractProductIdCandidates(text);
    assert.deepStrictEqual(got.sort(), expect.sort(), `extractProductIdCandidates("${text}") = ${JSON.stringify(got)}, expected ${JSON.stringify(expect)}`);
  }
  console.log('PASS: extractProductIdCandidates — SKU tokens, explicit-marker bare numbers, and the "رقم ٣ picking from a list" false-positive guard all behave correctly.');
}

// --- Part 2: productMatcher.js's findByIdCandidate against a synthetic catalog matching the REAL live "C0XX" id scheme ---
// Stub googleSheetsProducts BEFORE productMatcher's first require — productMatcher
// captures `require('../services/googleSheetsProducts')` into its own module-level
// binding at require time, so stubbing require.cache afterward would be too late.
const googleSheetsProductsPath = require.resolve('../src/services/googleSheetsProducts');
let fakeRemoteProducts = [];
require.cache[googleSheetsProductsPath] = {
  id: googleSheetsProductsPath,
  filename: googleSheetsProductsPath,
  loaded: true,
  exports: { async fetchProducts() { return fakeRemoteProducts; } },
};

const productMatcherPath = require.resolve('../src/bot/productMatcher');
delete require.cache[productMatcherPath];
const productMatcher = require('../src/bot/productMatcher');

const CATALOG = [
  { id: 'C001', name: 'كريم مرطب', category: 'skincare', price: '150', inStock: true },
  { id: 'C102', name: 'صن بلوك ديرماتيك SPF 50', category: 'skincare', price: '200', inStock: true },
  { id: 'C103', name: 'صن بلوك جل ديرماتيك', category: 'skincare', price: '210', inStock: false },
];

// --- Part 3: end-to-end through llmAgent.handleMessage (stubbed dependencies, same pattern as _tmp_test_mentioned_id_and_hallucination_fix.js) ---
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

const SUNBLOCK = { id: 'C102', name: 'صن بلوك ديرماتيك SPF 50 (Dermatique Sunblock SPF 50)', category: 'skincare', price: '200', inStock: true };
const CLEANSER = { id: 'C050', name: 'غسول للبشرة الدهنية', category: 'skincare', price: '90', inStock: true };

let nextOpenaiResponse = null;
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: { async generateStructuredReply() { return nextOpenaiResponse; } } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: { async generateStructuredReply() { return null; } } };
require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: { async searchProducts() { return [CLEANSER]; } } };
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
  // --- Part 2 ---
  fakeRemoteProducts = CATALOG;
  await productMatcher.refreshFromGoogleSheets();
  assert.strictEqual(productMatcher.findByIdCandidate('C102').id, 'C102', 'exact SKU match failed');
  assert.strictEqual(productMatcher.findByIdCandidate('c102').id, 'C102', 'case-insensitive exact match failed');
  assert.strictEqual(productMatcher.findByIdCandidate('102').id, 'C102', 'bare-number reconstruction against real catalog prefix+width failed');
  assert.strictEqual(productMatcher.findByIdCandidate('1').id, 'C001', 'bare-number reconstruction with leading-zero padding failed');
  assert.strictEqual(productMatcher.findByIdCandidate('999'), null, 'a number matching no real product must return null, never a guess');
  assert.strictEqual(productMatcher.findByIdCandidate(''), null);
  assert.strictEqual(productMatcher.findByIdCandidate(null), null);
  // GAP confirmed here and reconfirmed against the real live sheet in Part 4
  // below: a shortened letter-prefixed candidate that's missing its padding
  // zeros ("C1" for real id "C001") does NOT resolve — findByIdCandidate's
  // reconstruction branch only runs for purely-numeric candidates
  // (`/^\d+$/.test(upper)`), so a candidate that already has a letter prefix
  // but the wrong digit width just fails the exact match and returns null,
  // never reaching the width-padding logic at all.
  assert.strictEqual(productMatcher.findByIdCandidate('C1'), null, 'KNOWN GAP: a letter-prefixed candidate with the wrong digit width (missing its padding zeros) does not resolve');
  console.log('PASS: findByIdCandidate — exact match, case-insensitivity, bare-number-to-prefix reconstruction, and no-guess-on-miss all behave correctly; the "shortened SKU missing its padding" gap is documented.');

  // Swap in the SUNBLOCK/CLEANSER catalog llmAgent.js's own require('./productMatcher') will see for Part 3.
  fakeRemoteProducts = [SUNBLOCK, CLEANSER];
  await productMatcher.refreshFromGoogleSheets();

  // --- Part 3 ---
  // Traced first: idMentionProduct is NOT an unconditional pin for the
  // general chat flow (llmAgent.js ~1544-1586) — it only (a) guarantees the
  // resolved product is IN this turn's candidate list (selectCandidatesForTurn)
  // and (b) adds a prompt section telling the model this is a confirmed
  // selection, not a hint to explore. The actual session.recommendedProduct
  // pin still runs through the normal mentioned_product_ids/reply_text path
  // (applyValidatedOutput). Only handleProductImageRequest (the deterministic
  // photo-request branch) treats idMentionProduct as an unconditional
  // override, bypassing the model entirely. So scenarios 1-2 below use a
  // reply_text that actually names the product — matching what the new
  // buildIdMentionSection prompt instructs the model to do.

  // 1. Customer quotes an exact SKU; model complies with the new prompt guidance and names the product — pin follows.
  {
    const chatId = 'IDMENTION_1@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, mentioned_product_ids: [SUNBLOCK.id], reply_text: 'تمام، صن بلوك ديرماتيك SPF 50 متاح بسعر 200 جنيه. حابة تأكدي الطلب؟' };
    await llmAgent.handleMessage({ chatId, phone: '1', text: 'عايزة اطلب المنتج كود C102', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct && session.recommendedProduct.id, SUNBLOCK.id, 'expected the resolved id-mentioned product, named in reply_text, to be pinned');
    console.log('PASS: an explicit real SKU, with the model complying and naming it in reply_text, correctly pins the product.');
  }

  // 2. Bare number with explicit marker, resolved via prefix+width reconstruction.
  {
    const chatId = 'IDMENTION_2@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, mentioned_product_ids: [SUNBLOCK.id], reply_text: 'أكيد، صن بلوك ديرماتيك SPF 50 متاح، اتفضلي التفاصيل.' };
    await llmAgent.handleMessage({ chatId, phone: '2', text: 'ممكن تفاصيل المنتج رقم 102', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct && session.recommendedProduct.id, SUNBLOCK.id, 'expected "المنتج رقم 102" to resolve to C102 via prefix+width reconstruction');
    console.log('PASS: "المنتج رقم 102" (bare number + explicit marker) resolves to the real product C102.');
  }

  // 2b. RESIDUAL RISK, confirmed live (not yet fixed): if the customer
  // quotes a valid SKU but the model's reply_text does NOT name the product
  // (ignoring the new prompt instruction — the same "prompt-only isn't 100%
  // reliable" pattern this codebase has hit repeatedly, e.g. SPECIALIST_
  // REFERRAL/photo-availability hallucination), the id still resolves
  // correctly and reaches the candidate list, but session.recommendedProduct
  // is NOT pinned — unlike handleProductImageRequest's direct-photo path,
  // there is no deterministic backstop here for the general chat flow.
  {
    const chatId = 'IDMENTION_2C@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, mentioned_product_ids: [], reply_text: 'تمام، ده منتج ممتاز! حابة تأكدي الطلب؟' };
    await llmAgent.handleMessage({ chatId, phone: '2c', text: 'عايزة اطلب المنتج كود C102', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.ok(!session.recommendedProduct, 'documents the current gap: a non-compliant reply_text (product id resolved, but not named) leaves recommendedProduct unpinned in the general chat flow');
    console.log('DOCUMENTED GAP (not a test failure): a resolved id-mention only pins recommendedProduct if the model actually names the product in reply_text — no deterministic backstop yet for this path, unlike the photo-request branch.');
  }

  // --- 3. Picking "رقم ٣" off a numbered list must NOT be misread as a SKU lookup (the exact regression this codebase already fixed once for a different feature) ---
  {
    const chatId = 'IDMENTION_3@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, mentioned_product_ids: [CLEANSER.id], reply_text: 'غسول للبشرة الدهنية متاح بسعر 90 جنيه.' };
    await llmAgent.handleMessage({ chatId, phone: '3', text: 'رقم ٣', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct && session.recommendedProduct.id, CLEANSER.id, 'expected "رقم ٣" alone to fall through to normal mentioned_product_ids handling, not a false SKU match');
    console.log('PASS: bare "رقم ٣" (picking off a numbered list) is not misread as a catalog SKU lookup.');
  }

  // --- 4. A SKU-shaped token that matches no real product is silently ignored, not reported as "not found" ---
  {
    const chatId = 'IDMENTION_4@lid';
    nextOpenaiResponse = { ...VALID_BASE_RESPONSE, mentioned_product_ids: [], reply_text: 'أهلاً، تحبي مساعدة في إيه؟' };
    const result = await llmAgent.handleMessage({ chatId, phone: '4', text: 'عندي كود C999 مكتوب هنا بالغلط', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.ok(!session.recommendedProduct, 'expected an id-shaped token matching no real product to be silently ignored, not guessed at');
    void result;
    console.log('PASS: a SKU-shaped token that matches nothing real is silently ignored (falls through to normal flow), never guessed at.');
  }

  console.log('\n--- Part 4: verification against the REAL live Products sheet (not stubbed) ---');
  // Same reasoning as the pre-existing scripts/_tmp_test_product_image_variant_live.js:
  // synthetic fixtures can't catch a catalog-shape mismatch like the one this
  // test run just surfaced (stale products.json vs. the real, already-
  // restructured live sheet), so this part re-verifies against the actual
  // production Google Sheets API.
  delete require.cache[googleSheetsProductsPath]; // un-stub — use the real modules
  delete require.cache[googleSheetsPath];
  delete require.cache[productMatcherPath];
  const realGoogleSheets = require('../src/services/googleSheets');
  await realGoogleSheets.init();
  const realProductMatcher = require('../src/bot/productMatcher');
  const refreshed = await realProductMatcher.refreshFromGoogleSheets();
  assert.ok(refreshed, 'expected the real Products sheet to load successfully for this part to be meaningful');
  assert.strictEqual(realProductMatcher.getSource(), 'google-sheets');
  console.log(`Live catalog loaded: ${realProductMatcher.getProductCount()} products, source=${realProductMatcher.getSource()}`);

  const realCream = realProductMatcher.findByIdCandidate('18');
  const realGel = realProductMatcher.findByIdCandidate('19');
  assert.ok(realCream && realCream.id === 'C018', `expected bare "18" to resolve to real live id C018, got ${realCream && realCream.id}`);
  assert.ok(realGel && realGel.id === 'C019', `expected bare "19" to resolve to real live id C019, got ${realGel && realGel.id}`);
  console.log(`PASS (LIVE DATA): bare "18"/"19" correctly resolve to the real live sunblock cream/gel pair (${realCream.id}/${realGel.id}) via prefix+width reconstruction.`);

  const shortForm = realProductMatcher.findByIdCandidate('c18');
  assert.strictEqual(shortForm, null, 'CONFIRMED LIVE GAP: a shortened/unpadded real-world SKU variant ("c18" for the real id C018) does not resolve');
  console.log('CONFIRMED LIVE GAP (not a test failure, documented for the owner): typing "c18" instead of the full "C018" does not resolve, since findByIdCandidate\'s reconstruction path only triggers for purely-numeric candidates.');

  console.log('\nALL PRODUCT-ID-MENTION TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
