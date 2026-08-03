// Verifies the 2026-08-03 P0.2 fixes: deliveryFollowup.js and
// campaignWorker.js's runTestTriggerCheck now only mark a task "done" after
// a confirmed successful send, instead of unconditionally.
//
// deliveryFollowup.js persists to a real file (delivery_followup_state.json,
// hardcoded path, not injectable) — this test uses fake phone numbers that
// can't collide with real data, but still deletes that file afterward so a
// test run never leaves fabricated state behind for the real scheduler to
// load on its next real start.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const DELIVERY_STATE_PATH = path.join(__dirname, '..', 'delivery_followup_state.json');
const deliveryStateExistedBefore = fs.existsSync(DELIVERY_STATE_PATH);

(async function testDeliveryFollowupRetriesAfterFailedSend() {
  let clearedFollowupState = false;
  const googleSheetsStub = {
    async scanLeadsStatuses() {
      return [{ phone: '201000000002', orderStatus: 'Delivered' }];
    },
  };
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };
  const conversationMemoryStub = {
    isHumanHandoffCooldownActive() { return false; },
    getSession() { return {}; },
    updateSession() {},
  };
  require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

  delete require.cache[require.resolve('../src/bot/deliveryFollowup')];
  const deliveryFollowup = require('../src/bot/deliveryFollowup');

  let attempt = 0;
  const flakySendFn = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('WhatsApp client is not connected.');
  };
  const resolvePhoneToChatIdFn = async () => new Map([['201000000002', 'FOLLOWUP@lid']]);

  // First scan: send fails (client not ready) — must NOT be marked done.
  await deliveryFollowup.checkForDeliveredOrders(flakySendFn, resolvePhoneToChatIdFn);
  assert.strictEqual(attempt, 1, 'expected the first scan to attempt a send');

  // Second scan: same row still "Delivered" — must retry (not silently skipped).
  await deliveryFollowup.checkForDeliveredOrders(flakySendFn, resolvePhoneToChatIdFn);
  assert.strictEqual(attempt, 2, 'expected the second scan to retry the send since the first attempt failed and must not have been marked done');
  console.log('PASS: deliveryFollowup retries a Delivered row whose send previously failed, instead of silently marking it done.');
})()
  .then(async () => {
    // --- runTestTriggerCheck: failed send must leave TEST_TRIGGER=SEND ---
    const offersRows = [
      { rowNumber: 2, offerId: 'OFFER_1', offerName: 'Test', offerText: 'hello', campaignStatus: 'PUSH', testTrigger: 'SEND', lastTestSentAt: '', productId: '' },
    ];
    let clearCalls = 0;
    const googleSheetsStub2 = {
      async getOffersCampaignRows() { return offersRows.map((o) => ({ ...o })); },
      async setOfferLastTestSentAt() {},
      async clearOfferTestTrigger(rowNumber) {
        clearCalls += 1;
        const row = offersRows.find((o) => o.rowNumber === rowNumber);
        if (row) row.testTrigger = 'IDLE';
      },
    };
    require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub2 };

    const configPath = require.resolve('../src/config');
    const realConfig = require(configPath);
    require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { ...realConfig, adminWhatsappNumber: '201000000000' } };

    delete require.cache[require.resolve('../src/bot/campaignWorker')];
    const campaignWorker = require('../src/bot/campaignWorker');

    const failingSendFn = async () => { throw new Error('WhatsApp client is not connected.'); };
    await campaignWorker.runTestTriggerCheck(failingSendFn);
    assert.strictEqual(clearCalls, 0, 'expected clearOfferTestTrigger NOT to be called after a failed send');
    assert.strictEqual(offersRows[0].testTrigger, 'SEND', 'expected TEST_TRIGGER to remain SEND (visibly pending) after a failed send, not silently reset to IDLE');
    console.log('PASS: runTestTriggerCheck leaves TEST_TRIGGER=SEND after a failed send instead of silently clearing it.');

    console.log('\nALL P0.2 SCHEDULER TESTS PASSED');
    cleanupDeliveryStateFile();
    process.exit(0);
  })
  .catch((err) => {
    console.error('TEST FAILED:', err);
    cleanupDeliveryStateFile();
    process.exit(1);
  });

function cleanupDeliveryStateFile() {
  // Only remove it if this test run was the one that created it — never
  // touch a real pre-existing state file.
  if (!deliveryStateExistedBefore && fs.existsSync(DELIVERY_STATE_PATH)) {
    fs.unlinkSync(DELIVERY_STATE_PATH);
  }
}
