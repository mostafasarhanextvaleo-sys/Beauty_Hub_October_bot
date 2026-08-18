// Verifies the 2026-08-12 store-owner directive: runCampaignTick now
// broadcasts to EVERY row in Targeted_Clients (including already-ORDERED
// and already-REPLIED rows) sequentially in sheet order, using
// campaignStatus !== 'OFFER_SENT' as the only "already sent this round"
// gate — while still honoring Opt-Out/Bot-Paused/Blocked as hard
// boundaries (except the two protected owner test numbers). Also verifies
// the raised DAILY_SEND_LIMIT (50, was 20). Same stubbed-module pattern as
// the other campaignWorker.js tests in this file.
const assert = require('assert');

process.env.ADMIN_WHATSAPP_NUMBER = '201098175119';
delete process.env.CAMPAIGN_DAILY_SEND_LIMIT;

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const invoiceServicePath = require.resolve('../src/bot/invoiceService');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const productMatcherPath = require.resolve('../src/bot/productMatcher');
const chatLockPath = require.resolve('../src/utils/chatLock');
const adLeadDetectorPath = require.resolve('../src/bot/adLeadDetector');
const orderPipelinePath = require.resolve('../src/bot/orderPipeline');

require.cache[invoiceServicePath] = { id: invoiceServicePath, filename: invoiceServicePath, loaded: true, exports: {} };
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: {} };
require.cache[chatLockPath] = { id: chatLockPath, filename: chatLockPath, loaded: true, exports: { runExclusive: async (chatId, fn) => fn() } };
require.cache[adLeadDetectorPath] = { id: adLeadDetectorPath, filename: adLeadDetectorPath, loaded: true, exports: {} };
require.cache[orderPipelinePath] = { id: orderPipelinePath, filename: orderPipelinePath, loaded: true, exports: { resetConfirmationAskState: () => {} } };

function freshCampaignWorker(googleSheetsStub, sessionStore) {
  require.cache[conversationMemoryPath] = {
    id: conversationMemoryPath,
    filename: conversationMemoryPath,
    loaded: true,
    exports: {
      getSession: (chatId) => sessionStore[chatId] || (sessionStore[chatId] = {}),
      updateSession: (chatId, patch) => { sessionStore[chatId] = { ...(sessionStore[chatId] || {}), ...patch }; },
    },
  };
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };
  const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');
  delete require.cache[campaignWorkerPath];
  return require(campaignWorkerPath);
}

(async () => {
  // --- Scenario 1: an ORDERED row and a REPLIED row are both still sent to
  // (previously hard-excluded); Opt-Out/Blocked/Bot-Paused rows are skipped;
  // sends happen in sheet (array) order. ---
  {
    const rows = [
      { chatId: 'a@c.us', phoneNumber: '201200000001', campaignStatus: 'DECLINED', optOut: true, touches: 0 },
      { chatId: 'b@c.us', phoneNumber: '201200000002', campaignStatus: 'ORDERED', orderedAt: '2026-08-01', touches: 0 },
      { chatId: 'c@c.us', phoneNumber: '201200000003', campaignStatus: 'REPLIED', touches: 1 },
      { chatId: 'd@c.us', phoneNumber: '201200000004', campaignStatus: 'ON_HOLD', blocked: true, touches: 0 },
      { chatId: 'e@c.us', phoneNumber: '201200000005', campaignStatus: 'PENDING', botPaused: true, touches: 0 },
      { chatId: 'f@c.us', phoneNumber: '201200000006', campaignStatus: 'OFFER_SENT', touches: 1 },
      { chatId: 'g@c.us', phoneNumber: '201200000007', campaignStatus: 'PENDING', touches: 0 },
    ];
    const upserts = [];
    const googleSheetsStub = {
      setLastCampaignTickAt: async () => {},
      getOffersCampaignRows: async () => [{ rowNumber: 1, offerId: 'OFFER_1', offerText: 'عرض تجريبي', campaignStatus: 'PUSH', productId: null }],
      getTargetedClientsRows: async () => rows,
      upsertTargetedClient: async (chatId, patch) => {
        upserts.push({ chatId, patch });
        const row = rows.find((r) => r.chatId === chatId);
        Object.assign(row, patch);
      },
    };
    const campaignWorker = freshCampaignWorker(googleSheetsStub, {});

    // Row 'a' (optOut) and 'd' (blocked) and 'e' (botPaused) must all be
    // skipped; 'f' is already OFFER_SENT so skipped too. First eligible in
    // sheet order is 'b' (ORDERED) — must now be sent to.
    const sent1 = [];
    await campaignWorker.runCampaignTick(async (jid, text) => sent1.push({ jid, text }));
    assert.strictEqual(sent1.length, 1);
    assert.strictEqual(sent1[0].jid, 'b@c.us', 'the ORDERED row must be the next send target, not skipped');
    assert.strictEqual(rows.find((r) => r.chatId === 'b@c.us').campaignStatus, 'OFFER_SENT');

    // Next tick: 'b' is now OFFER_SENT, so next eligible is 'c' (REPLIED) —
    // must also now be sent to.
    const sent2 = [];
    await campaignWorker.runCampaignTick(async (jid, text) => sent2.push({ jid, text }));
    assert.strictEqual(sent2.length, 1);
    assert.strictEqual(sent2[0].jid, 'c@c.us', 'the REPLIED row must be the next send target, not skipped');

    // Next tick: next eligible is 'g' (PENDING) — a,d,e,f all remain excluded/already-sent.
    const sent3 = [];
    await campaignWorker.runCampaignTick(async (jid, text) => sent3.push({ jid, text }));
    assert.strictEqual(sent3.length, 1);
    assert.strictEqual(sent3[0].jid, 'g@c.us');

    // Next tick: nothing eligible left (a=optOut, d=blocked, e=botPaused, all others OFFER_SENT).
    const sent4 = [];
    await campaignWorker.runCampaignTick(async (jid, text) => sent4.push({ jid, text }));
    assert.strictEqual(sent4.length, 0, 'no more eligible rows — opt-out/blocked/paused rows must never be sent to');

    console.log('PASS: scenario 1 — broadcasts to ordered/replied rows in sheet order, still honors Opt-Out/Blocked/Bot-Paused as hard boundaries.');
  }

  // --- Scenario 2: DAILY_SEND_LIMIT default is now 50, not 20 ---
  {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      chatId: `bulk${i}@c.us`, phoneNumber: `20120000${1000 + i}`, campaignStatus: 'PENDING', touches: 0,
      sentAt: i < 21 ? new Date().toISOString() : undefined, // 21 already sent today
    }));
    const googleSheetsStub = {
      setLastCampaignTickAt: async () => {},
      getOffersCampaignRows: async () => [{ rowNumber: 1, offerId: 'OFFER_1', offerText: 'عرض', campaignStatus: 'PUSH', productId: null }],
      getTargetedClientsRows: async () => rows,
      upsertTargetedClient: async () => {},
    };
    const campaignWorker = freshCampaignWorker(googleSheetsStub, {});
    const sent = [];
    await campaignWorker.runCampaignTick(async (jid, text) => sent.push({ jid, text }));
    assert.strictEqual(sent.length, 1, '21 sent today is under the new 50 cap, so a send must still go out (would have been blocked under the old 20 cap)');
    console.log('PASS: scenario 2 — daily send cap raised to 50 (21 sent today no longer blocks the old 20 cap).');
  }

  // --- Scenario 3: appendOfferToSessionHistory still threads the sent offer
  // into session.llm.history so the bot's next reply is grounded in it
  // (Context Alignment requirement) — verified for an already-ORDERED row too.
  {
    const rows = [{ chatId: 'ordered@c.us', phoneNumber: '201200009999', campaignStatus: 'ORDERED', orderedAt: '2026-08-01', touches: 0 }];
    const googleSheetsStub = {
      setLastCampaignTickAt: async () => {},
      getOffersCampaignRows: async () => [{ rowNumber: 1, offerId: 'OFFER_1', offerText: 'عرض جديد للعملاء', campaignStatus: 'PUSH', productId: null }],
      getTargetedClientsRows: async () => rows,
      upsertTargetedClient: async () => {},
    };
    const sessionStore = {};
    const campaignWorker = freshCampaignWorker(googleSheetsStub, sessionStore);
    await campaignWorker.runCampaignTick(async () => {});
    const history = sessionStore['ordered@c.us'].llm.history;
    assert.strictEqual(history[history.length - 1].content, 'عرض جديد للعملاء', 'the newest campaign message must be the latest entry in session history');
    console.log('PASS: scenario 3 — sent offer is appended to session history (bot context) even for a previously-ORDERED customer.');
  }

  console.log('ALL PASS: campaign broadcast mode — every eligible row reached, hard boundaries preserved, daily cap raised, context alignment intact.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
