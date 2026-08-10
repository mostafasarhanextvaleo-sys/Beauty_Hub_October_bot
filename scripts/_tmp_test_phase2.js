// Isolated tests for the 2026-08-02 Phase 2 (P2/P3) fixes. Stubs
// googleSheets/conversationMemory/productMatcher via require.cache so
// nothing touches production data or makes real LLM API calls.
const assert = require('assert');

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const productMatcherPath = require.resolve('../src/bot/productMatcher');

const HAIR_PRODUCT = { id: 'H1', name: 'شامبو تجريبي', price: '100', category: 'haircare' };
const FOOT_PRODUCT = { id: 'B1', name: 'مبرد قدم تجريبي', price: '120', category: 'bodycare' };

// --- Test group 1: smart category matching (campaignWorker.js) ---
(function testCategoryMatching() {
  let offers = [
    { rowNumber: 2, offerId: 'OFFER_1', offerName: 'Foot Offer', offerText: 'foot text', campaignStatus: 'PUSH', testTrigger: 'IDLE', lastTestSentAt: '', productId: 'B1' },
    { rowNumber: 3, offerId: 'OFFER_2', offerName: 'Hair Offer', offerText: 'hair text', campaignStatus: 'PUSH', testTrigger: 'IDLE', lastTestSentAt: '', productId: 'H1' },
  ];
  let targetedClients = [
    { rowNumber: 2, chatId: 'HAIRLEAD@lid', phoneNumber: '1', customerName: '', category: 'تساقط الشعر بشكل كبير', campaignStatus: 'PENDING', optOut: false, touches: 0, objectionReason: '', orderedAt: '' },
  ];
  const googleSheetsStub = {
    async getOffersCampaignRows() { return offers.map((o) => ({ ...o })); },
    async getTargetedClientsRows() { return targetedClients.map((r) => ({ ...r })); },
    async upsertTargetedClient(chatId, fields) { Object.assign(targetedClients.find((r) => r.chatId === chatId), fields); },
    async setLastCampaignTickAt() {},
    // Used by llmAgent.js's buildCustomerProfile — inherited by test group 2
    // below too, since this stub is never cleared from require.cache between
    // groups. Empty history is the correct "no prior orders" case.
    getCustomerHistory() { return []; },
  };
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };
  const fakeSessions = new Map();
  const conversationMemoryStub = {
    getSession(chatId) { if (!fakeSessions.has(chatId)) fakeSessions.set(chatId, { chatId, llm: { history: [] } }); return fakeSessions.get(chatId); },
    updateSession(chatId, patch) { Object.assign(conversationMemoryStub.getSession(chatId), patch); },
  };
  require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };
  const productMatcherStub = { getById(id) { return id === 'B1' ? { ...FOOT_PRODUCT } : id === 'H1' ? { ...HAIR_PRODUCT } : null; } };
  require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: productMatcherStub };

  delete require.cache[require.resolve('../src/bot/campaignWorker')];
  const campaignWorker = require('../src/bot/campaignWorker');

  const sent = [];
  return campaignWorker.runCampaignTick(async (chatId, text) => { sent.push({ chatId, text }); }).then(() => {
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].text, 'hair text', 'a hair-interested lead must get the hair offer, not round-robin\'s first-in-line foot offer');
    console.log('PASS: category matching correctly routed a hair-loss lead to the hair offer, skipping the mismatched foot offer');
  });
})()
  // --- Test group 2: repetition tracking, NOT a forced handover (llmAgent.js) ---
  // 2026-08-04 update: this used to verify the 3rd identical message forced a
  // deterministic handover. The 2026-08-04 zero-lock safeguard removed that
  // hard escalation entirely (repeating yourself isn't hard evidence a human
  // is needed) — see scripts/_tmp_test_zero_lock.js for the full safeguard
  // coverage. Updated here to verify the counter still tracks correctly but
  // no longer forces anything.
  .then(async () => {
    delete require.cache[conversationMemoryPath];
    delete require.cache[productMatcherPath];
    delete require.cache[require.resolve('../src/bot/llmAgent')];
    delete require.cache[require.resolve('../src/bot/productSearch')];

    const fakeSessions = new Map();
    const conversationMemoryStub = {
      STAGES: { CLOSED: 'CLOSED' },
      getSession(chatId) { if (!fakeSessions.has(chatId)) fakeSessions.set(chatId, { chatId, llm: { history: [] } }); return fakeSessions.get(chatId); },
      updateSession(chatId, patch) { Object.assign(conversationMemoryStub.getSession(chatId), patch); },
      resetSession() {},
      getAllSessions() { return fakeSessions; },
      HUMAN_HANDOFF_COOLDOWN_MS: 86400000,
      isHumanHandoffCooldownActive() { return false; },
      DELIVERY_FEEDBACK_WINDOW_MS: 172800000,
      isOrderConfirmationReplyExpired() { return false; },
      isFeedbackRatingExpired() { return false; },
    };
    require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

    const llmAgent = require('../src/bot/llmAgent');
    const chatId = 'REPEATER@lid';

    // Seed session with 2 prior identical user turns already recorded (as if
    // this is the 3rd time in a row) plus consecutiveRepeats already at 1
    // from the 2nd occurrence.
    conversationMemoryStub.updateSession(chatId, {
      llm: { history: [{ role: 'user', content: 'تم' }, { role: 'assistant', content: 'رد عام' }] },
      consecutiveRepeats: 1,
    });

    const result = await llmAgent.handleMessage({ chatId, phone: '201000000000', text: 'تم', senderName: 'Test' });
    assert.ok(!result.reply.includes('فريقنا'), 'the 3rd identical message must NOT be the old hard-escalation canned reply');
    const session = conversationMemoryStub.getSession(chatId);
    assert.strictEqual(session.humanHandover, false, 'the 3rd identical message must not force a handover (2026-08-04 zero-lock safeguard)');
    assert.strictEqual(session.consecutiveRepeats, 2, 'the counter itself still tracks correctly (0 -> 1 -> 2), just never forces anything');
    console.log('PASS: 3rd identical message no longer forces a handover; the LLM still handles the turn normally.');
  })
  .then(() => {
    console.log('\nALL PHASE 2 TESTS PASSED');
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
  });
