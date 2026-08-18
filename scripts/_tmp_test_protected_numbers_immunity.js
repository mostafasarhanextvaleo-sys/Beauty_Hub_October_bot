// Verifies the 2026-08-12 store-owner directive: the two admin/test numbers
// (Main 201098175119 = config.adminWhatsappNumber, Secondary 201156630487 =
// CAMPAIGN_TEST_TRIGGER_SECONDARY_NUMBER) can never be excluded by the
// Blocked list, Opt-Out auto-detection, Bot Paused, or the per-contact touch
// cap that exist to protect *real customers*. Same safe stubbed-module
// pattern as _tmp_test_campaign_test_trigger_dual_recipient.js — never
// touches real Sheets state.
const assert = require('assert');

process.env.ADMIN_WHATSAPP_NUMBER = '201098175119';
const MAIN = '201098175119';
const SECONDARY = '201156630487';

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

function freshCampaignWorker(googleSheetsStub) {
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };
  const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');
  delete require.cache[campaignWorkerPath];
  return require(campaignWorkerPath);
}

(async () => {
  // --- Scenario 1: isContactBlocked/isBotPausedForContact ignore the Sheet's
  // own Blocked/Bot-Paused flags for the two protected numbers ---
  {
    const rows = [
      { chatId: `${MAIN}@c.us`, phoneNumber: MAIN, blocked: true, botPaused: true },
      { chatId: `${SECONDARY}@c.us`, phoneNumber: SECONDARY, blocked: true, botPaused: true },
      { chatId: '201200000000@c.us', phoneNumber: '201200000000', blocked: true, botPaused: true },
    ];
    const campaignWorker = freshCampaignWorker({ getTargetedClientsRows: async () => rows });
    await campaignWorker.startPausedContactsAutoRefresh(3600 * 1000);
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget initial refresh land

    assert.strictEqual(campaignWorker.isContactBlocked(`${MAIN}@c.us`), false, 'main number must never read as Blocked');
    assert.strictEqual(campaignWorker.isContactBlocked(`${SECONDARY}@c.us`), false, 'secondary number must never read as Blocked');
    assert.strictEqual(campaignWorker.isBotPausedForContact(`${MAIN}@c.us`), false, 'main number must never read as Bot Paused');
    assert.strictEqual(campaignWorker.isBotPausedForContact(`${SECONDARY}@c.us`), false, 'secondary number must never read as Bot Paused');
    assert.strictEqual(campaignWorker.isContactBlocked('201200000000@c.us'), true, 'a real, unrelated customer must still be Blocked as normal (no accidental blanket bypass)');
    console.log('PASS: scenario 1 — protected numbers immune to Blocked/Bot Paused, unrelated customers unaffected.');
  }

  // --- Scenario 2: opt-out auto-detection never marks the protected numbers DECLINED ---
  {
    const upserts = [];
    const rowMain = { chatId: `${MAIN}@lid`, phoneNumber: MAIN, campaignStatus: 'OFFER_SENT' };
    const campaignWorker = freshCampaignWorker({
      getTargetedClientsRows: async () => [rowMain],
      upsertTargetedClient: async (chatId, patch) => upserts.push({ chatId, patch }),
    });

    await campaignWorker.handleInboundMessage(`${MAIN}@lid`, 'وقف الرسائل'); // explicit opt-out phrase

    assert.strictEqual(upserts.length, 1, 'must still record the reply');
    assert.strictEqual(upserts[0].patch.optOut, undefined, 'must NOT set optOut for the protected number');
    assert.strictEqual(upserts[0].patch.campaignStatus, 'REPLIED', 'must be tracked as a normal REPLIED, not DECLINED');
    console.log('PASS: scenario 2 — opt-out phrasing from the protected main number is never recorded as an opt-out.');
  }

  // --- Scenario 2b: same opt-out phrase from a real customer still works normally ---
  {
    const upserts = [];
    const rowReal = { chatId: '201200000000@c.us', phoneNumber: '201200000000', campaignStatus: 'OFFER_SENT' };
    const campaignWorker = freshCampaignWorker({
      getTargetedClientsRows: async () => [rowReal],
      upsertTargetedClient: async (chatId, patch) => upserts.push({ chatId, patch }),
    });

    await campaignWorker.handleInboundMessage('201200000000@c.us', 'وقف الرسائل');

    assert.strictEqual(upserts[0].patch.optOut, true, 'a real customer opting out must still be honored');
    assert.strictEqual(upserts[0].patch.campaignStatus, 'DECLINED');
    console.log('PASS: scenario 2b — real-customer opt-out is completely unaffected by this change.');
  }

  // --- Scenario 3: runCampaignTick's eligibility filter includes a protected
  // number despite optOut/blocked/botPaused/touches-at-cap, and skips a real
  // customer in the identical state ---
  {
    const rowProtected = {
      chatId: `${SECONDARY}@c.us`, phoneNumber: SECONDARY, campaignStatus: 'PENDING',
      optOut: true, botPaused: true, blocked: true, touches: 99,
    };
    const rowReal = {
      chatId: '201200000000@c.us', phoneNumber: '201200000000', campaignStatus: 'PENDING',
      optOut: true, botPaused: true, blocked: true, touches: 99,
    };
    const sent = [];
    const campaignWorker = freshCampaignWorker({
      setLastCampaignTickAt: async () => {},
      getOffersCampaignRows: async () => [{ rowNumber: 1, offerId: 'OFFER_1', offerText: 'عرض', campaignStatus: 'PUSH', productId: null }],
      getTargetedClientsRows: async () => [rowProtected, rowReal],
      upsertTargetedClient: async () => {},
    });

    await campaignWorker.runCampaignTick(async (jid, text) => sent.push({ jid, text }));

    assert.strictEqual(sent.length, 1, 'exactly one send this tick');
    assert.ok(sent[0].jid.includes(SECONDARY), 'the protected number must be selected despite optOut/blocked/botPaused/touch-cap');
    console.log('PASS: scenario 3 — protected number bypasses optOut/blocked/botPaused/touch-cap in the automated campaign filter; a real customer in the identical state is correctly excluded.');
  }

  // --- Scenario 4: runSendNowCheck sends to the protected number despite optOut/blocked/botPaused ---
  {
    const sent = [];
    const upserts = [];
    const rowProtected = {
      chatId: `${MAIN}@c.us`, phoneNumber: MAIN, sendNow: true,
      optOut: true, botPaused: true, blocked: true, touches: 0,
    };
    const campaignWorker = freshCampaignWorker({
      getTargetedClientsRows: async () => [rowProtected],
      getOffersCampaignRows: async () => [{ rowNumber: 1, offerId: 'OFFER_1', offerName: 'Offer 1', offerText: 'عرض', campaignStatus: 'PUSH', productId: null }],
      upsertTargetedClient: async (chatId, patch) => upserts.push({ chatId, patch }),
    });

    await campaignWorker.runSendNowCheck(async (jid, text) => sent.push({ jid, text }));

    assert.strictEqual(sent.length, 1, 'Send Now must still deliver to the protected number despite optOut/blocked/botPaused');
    assert.ok(sent[0].jid.includes(MAIN));
    console.log('PASS: scenario 4 — Send Now delivers to the protected main number despite optOut/blocked/botPaused.');
  }

  console.log('ALL PASS: protected-number immunity across Blocked/Bot Paused/Opt-Out/touch-cap, real customers unaffected.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
