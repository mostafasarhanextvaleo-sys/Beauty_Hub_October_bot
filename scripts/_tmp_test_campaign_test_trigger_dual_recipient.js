// Verifies the 2026-08-12 change (store owner directive): campaign
// TEST_TRIGGER sends now fan out to TWO numbers — config.adminWhatsappNumber
// (main, 201098175119) and the new hardcoded CAMPAIGN_TEST_TRIGGER_SECONDARY_NUMBER
// (201156630487) — and only clears TEST_TRIGGER/stamps LAST_TEST_SENT_AT once
// BOTH sends succeed. Same safe stubbed-module pattern as the other
// campaignWorker.js tests in this file (never touch the real Sheets state).
const assert = require('assert');

process.env.ADMIN_WHATSAPP_NUMBER = '201098175119';

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const invoiceServicePath = require.resolve('../src/bot/invoiceService');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const productMatcherPath = require.resolve('../src/bot/productMatcher');
const chatLockPath = require.resolve('../src/utils/chatLock');
const adLeadDetectorPath = require.resolve('../src/bot/adLeadDetector');
const orderPipelinePath = require.resolve('../src/bot/orderPipeline');

require.cache[invoiceServicePath] = { id: invoiceServicePath, filename: invoiceServicePath, loaded: true, exports: {} };
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: { getSession: () => ({}), updateSession: () => {} } };
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: {} };
require.cache[chatLockPath] = { id: chatLockPath, filename: chatLockPath, loaded: true, exports: { runExclusive: async (chatId, fn) => fn() } };
require.cache[adLeadDetectorPath] = { id: adLeadDetectorPath, filename: adLeadDetectorPath, loaded: true, exports: {} };
require.cache[orderPipelinePath] = { id: orderPipelinePath, filename: orderPipelinePath, loaded: true, exports: { resetConfirmationAskState: () => {} } };

(async () => {
  // --- Scenario A: both sends succeed -> both recipients get it, TEST_TRIGGER clears ---
  {
    const sentTo = [];
    const clearCalls = [];
    const lastSentCalls = [];
    const googleSheetsStub = {
      async getOffersCampaignRows() {
        return [{ rowNumber: 1, offerId: 'OFFER_1', offerText: 'عرض تجريبي', testTrigger: 'SEND' }];
      },
      async clearOfferTestTrigger(rowNumber) { clearCalls.push(rowNumber); },
      async setOfferLastTestSentAt(rowNumber, ts) { lastSentCalls.push({ rowNumber, ts }); },
    };
    require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

    const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');
    delete require.cache[campaignWorkerPath];
    const campaignWorker = require(campaignWorkerPath);

    const sendMessageFn = async (jid, text) => { sentTo.push({ jid, text }); };
    await campaignWorker.runTestTriggerCheck(sendMessageFn);

    assert.strictEqual(sentTo.length, 2, 'must send to exactly 2 recipients');
    assert.ok(sentTo.some((s) => s.jid.includes('201098175119')), 'must send to the main number');
    assert.ok(sentTo.some((s) => s.jid.includes('201156630487')), 'must send to the secondary number');
    assert.deepStrictEqual(clearCalls, [1], 'TEST_TRIGGER must clear once both sends succeed');
    assert.strictEqual(lastSentCalls.length, 1, 'LAST_TEST_SENT_AT must be stamped once both sends succeed');
    console.log('PASS: scenario A — both recipients get the test message, TEST_TRIGGER clears.');
  }

  // --- Scenario B: secondary send fails -> TEST_TRIGGER must NOT clear ---
  {
    const clearCalls = [];
    const lastSentCalls = [];
    const googleSheetsStub = {
      async getOffersCampaignRows() {
        return [{ rowNumber: 2, offerId: 'OFFER_2', offerText: 'عرض تاني', testTrigger: 'SEND' }];
      },
      async clearOfferTestTrigger(rowNumber) { clearCalls.push(rowNumber); },
      async setOfferLastTestSentAt(rowNumber, ts) { lastSentCalls.push({ rowNumber, ts }); },
    };
    require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

    const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');
    delete require.cache[campaignWorkerPath];
    const campaignWorker = require(campaignWorkerPath);

    const sendMessageFn = async (jid) => {
      if (jid.includes('201156630487')) throw new Error('simulated send failure to secondary number');
    };
    await campaignWorker.runTestTriggerCheck(sendMessageFn);

    assert.strictEqual(clearCalls.length, 0, 'TEST_TRIGGER must stay SEND (not cleared) if any recipient fails');
    assert.strictEqual(lastSentCalls.length, 0, 'LAST_TEST_SENT_AT must not be stamped if any recipient fails');
    console.log('PASS: scenario B — a failed send to either recipient leaves TEST_TRIGGER set for retry, does not falsely mark success.');
  }

  console.log('ALL PASS: campaign test-trigger dual-recipient fan-out.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
