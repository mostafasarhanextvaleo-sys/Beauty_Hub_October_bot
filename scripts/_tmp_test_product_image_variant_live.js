// Live-catalog verification (not committed, not a stub-based unit test) for
// the 2026-08-09 findNamedAlternativeProduct fix in llmAgent.js — confirmed
// live, chatId 22299554107457@lid: asking for the pinned cream sunblock's
// photo, then "دا الكريم محتاج صوره الجيل" (asking for the GEL variant
// instead), kept re-sending the CREAM's photo both times. Runs against the
// REAL production Products sheet (productMatcher NOT stubbed) so the
// MIN_SHARED_TOKENS_FOR_VARIANT tuning is validated against real data, not a
// synthetic fixture — same reasoning as every other "verified against real
// systems" step in this deploy.
const assert = require('assert');

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const openaiServicePath = require.resolve('../src/services/openaiService');
const geminiServicePath = require.resolve('../src/services/geminiService');
const campaignKnowledgePath = require.resolve('../src/bot/campaignKnowledge');
const routineBundlesPath = require.resolve('../src/bot/routineBundles');
const trainingDataLoggerPath = require.resolve('../src/utils/trainingDataLogger');
const agentStatsPath = require.resolve('../src/bot/agentStats');
// Deliberately NOT stubbed here (unlike the other _tmp_test_*.js files) —
// this script's whole point is exercising productMatcher/googleSheetsProducts
// against the REAL live Products sheet, so googleSheets itself must be real
// too. llmAgent.js's own incidental calls into it (getCustomerHistory etc.)
// just hit the real, read-only Sheets API, which is harmless.

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

  delete require.cache[require.resolve('../src/bot/llmAgent')];
  const llmAgent = require('../src/bot/llmAgent');

  // 2026-08-12: catalog id scheme changed from plain numbers to "C"-prefixed
  // SKUs since this test was written (ids 18/19 no longer resolve) — updated
  // to the current live equivalents (C018/C019, same real products).
  const cream = productMatcher.getById('C018');
  const gel = productMatcher.getById('C019');
  assert.ok(cream && gel, 'expected the real sunblock cream/gel pair (ids C018/C019) to still exist in the live catalog');

  // --- 1. The exact real failing message: must now find the GEL variant, not repeat the cream ---
  {
    const chatId = 'LIVE_VARIANT_1@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: cream, stage: 'RECOMMENDED', shownProductIds: [cream.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '1', text: 'دا الكريم محتاج صوره الجيل', senderName: 'x' });
    console.log('Reply:', result.reply);
    if (gel.imageUrl) {
      assert.ok(result.productImage, 'expected a productImage to be sent');
      assert.strictEqual(result.productImage.url, gel.imageUrl, 'expected the GEL variant\'s real sheet URL, not the cream\'s');
    } else {
      assert.ok(result.reply.includes(gel.name), 'expected the graceful reply to name the GEL variant specifically, not the cream');
    }
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, gel.id, 'expected the session to now be pinned to the GEL variant');
    console.log('PASS: the real failing message now correctly resolves to the GEL variant (id 19), not the pinned cream (id 18).');
  }

  // --- 2. A plain re-ask with no distinguishing word must NOT override the pin ---
  {
    const chatId = 'LIVE_VARIANT_2@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: cream, stage: 'RECOMMENDED', shownProductIds: [cream.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '2', text: 'ممكن صورة تانية', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, cream.id, 'expected the pin to stay unchanged with no distinguishing word');
    console.log('PASS: a vague re-ask with no distinguishing word leaves the pin unchanged.');
  }

  // --- 3. An unrelated question (price) must NOT override the pin ---
  {
    const chatId = 'LIVE_VARIANT_3@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: cream, stage: 'RECOMMENDED', shownProductIds: [cream.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '3', text: 'السعر كام وممكن صورة', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, cream.id, 'expected an unrelated word (price) to never override the pin');
    console.log('PASS: an unrelated distinguishing-looking word (price question) does not override the pin.');
  }

  // --- 4. 2026-08-09 follow-up bug (caught live, SAME chatId, right after the
  //        fix above shipped): "صورة الجل" as ONE message still failed —
  //        stripDefiniteArticle's length guard was "> 4", but "الجل" is
  //        EXACTLY 4 characters, so it was never stripped to "جل" and never
  //        matched the gel product's name. ---
  {
    const chatId = 'LIVE_VARIANT_4@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: cream, stage: 'RECOMMENDED', shownProductIds: [cream.id] });
    const result = await llmAgent.handleMessage({ chatId, phone: '4', text: 'صورة الجل', senderName: 'x' });
    if (gel.imageUrl) {
      assert.ok(result.productImage, 'expected a productImage for the single-message "صورة الجل" case');
      assert.strictEqual(result.productImage.url, gel.imageUrl);
    }
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, gel.id, '"الجل" (exactly 4 chars) must resolve to the gel variant, not stay on the cream');
    console.log('PASS: single-message "صورة الجل" (the 4-char definite-article length-guard bug) now resolves correctly.');
  }

  // --- 5. The ACTUAL real cross-turn repro: customer names the variant in
  //        one turn ("الجل", which alone isn't a photo request and falls
  //        through to general consultation), then asks for the photo in a
  //        SEPARATE later turn ("مفيش صوره بيه") that doesn't repeat the
  //        product word at all. Confirmed live, chatId 22299554107457@lid,
  //        2026-08-09 05:51 — kept sending the cream both times. ---
  {
    const chatId = 'LIVE_VARIANT_5@lid';
    conversationMemoryStub.updateSession(chatId, { recommendedProduct: cream, stage: 'RECOMMENDED', shownProductIds: [cream.id] });
    await llmAgent.handleMessage({ chatId, phone: '5', text: 'الجل', senderName: 'x' });
    const result = await llmAgent.handleMessage({ chatId, phone: '5', text: 'مفيش صوره بيه', senderName: 'x' });
    if (gel.imageUrl) {
      assert.ok(result.productImage, 'expected a productImage once the photo-request turn arrives, using the PRIOR turn\'s product mention');
      assert.strictEqual(result.productImage.url, gel.imageUrl, 'expected the gel\'s URL, carried forward from the earlier "الجل" turn');
    }
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, gel.id);
    console.log('PASS: the exact real cross-turn repro ("الجل" then a separate bare photo request) now correctly resolves to the gel variant.');
  }

  // --- 6. 2026-08-09, deeper follow-up bug: session.recommendedProduct was
  //        STALE/WRONG (pointing at an unrelated product, "غسول دير للوجه" /
  //        Dear Facial Cleanser, id 14) even though Sara's own last reply had
  //        just confirmed a completely different product ("غسول ديرماتيك
  //        للبشرة الدهنية والمختلطة", id 1) by name. Confirmed live, same
  //        chatId, right after the gel/cream fix shipped — a customer picked
  //        option "3" from a numbered list, Sara's reply named the right
  //        product, but the NEXT photo request sent an unrelated cleanser's
  //        photo instead. Root cause: session.recommendedProduct can silently
  //        go stale whenever the model's mentioned_product_ids doesn't
  //        include/match what reply_text just said — not specific to the
  //        gel/cream pair. Fixed by cross-checking the pin against Sara's own
  //        last reply and recovering from session.shownProductIds when they
  //        disagree (see the "Ground-truth check" comment in
  //        handleProductImageRequest). ---
  {
    const dearCleanser = productMatcher.getById('C014');
    const target = productMatcher.getById('C001');
    assert.ok(dearCleanser && target, 'expected both real products (ids C014 and C001) to still exist in the live catalog');

    const chatId = 'LIVE_VARIANT_6_STALE_PIN@lid';
    conversationMemoryStub.updateSession(chatId, {
      recommendedProduct: dearCleanser, // the WRONG, stale pin
      stage: 'RECOMMENDED',
      shownProductIds: [dearCleanser.id, target.id],
      llm: {
        history: [
          { role: 'user', content: 'رقم ٣' },
          {
            role: 'assistant',
            content: `${target.name} هو غسول جل مطهر ينظف بعمق دون تدمير حاجز الرطوبة، وينظم الدهون ويمنع ظهور الحبوب. سعره 160 جنيه. تحبي تحجزيه؟`,
          },
        ],
      },
    });

    const result = await llmAgent.handleMessage({ chatId, phone: '6', text: 'ممكن صوره', senderName: 'x' });
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.recommendedProduct.id, target.id, 'expected the stale pin to be corrected to the product Sara\'s own last reply actually confirmed');
    if (target.imageUrl) {
      assert.ok(result.productImage, 'expected a productImage for the recovered, correct product');
      assert.strictEqual(result.productImage.url, target.imageUrl);
    } else {
      assert.ok(result.reply.includes(target.name.split('(')[0].trim()), 'expected the reply to name the RECOVERED product, not the stale wrong pin');
    }
    assert.ok(!result.reply.includes(dearCleanser.name.split('(')[0].trim()), 'expected the reply to NOT reference the stale wrong pin at all');
    console.log('PASS: a stale/wrong session pin is corrected against what Sara\'s own last reply actually confirmed, using shownProductIds.');
  }

  console.log('\nALL LIVE-CATALOG VARIANT TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
