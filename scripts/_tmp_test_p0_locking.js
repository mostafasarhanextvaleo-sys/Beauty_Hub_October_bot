// Verifies the 2026-08-03 P0 concurrency fix: campaignWorker.js's
// Targeted_Clients writers now share the same per-chatId lock
// (src/utils/chatLock.js) as whatsapp/client.js's message-handling lock.
// Reproduces the exact race documented in the audit: a campaign tick is
// mid-way through marking a row OFFER_SENT (with an artificial delay to
// widen the window) at the same instant the customer's own reply arrives.
// Before the fix, handleInboundMessage's independent read could see the
// stale PENDING status and silently drop the reply (including a possible
// opt-out) with the row stuck at OFFER_SENT forever. After the fix, the
// read is queued behind the write by the shared lock, so the reply is
// always correctly recorded as REPLIED.
const assert = require('assert');

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const productMatcherPath = require.resolve('../src/bot/productMatcher');

const CHAT_ID = 'RACECONTACT@lid';
const rows = [
  { rowNumber: 2, chatId: CHAT_ID, phoneNumber: '201000000001', customerName: 'Race Test', category: '', campaignStatus: 'PENDING', leadSource: '', recencyTier: '', touches: 0, objectionReason: '', optOut: false, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '', offerSent: '' },
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const googleSheetsStub = {
  async getOffersCampaignRows() {
    return [{ rowNumber: 2, offerId: 'OFFER_1', offerName: 'Test Offer', offerText: 'offer text', campaignStatus: 'PUSH', testTrigger: 'IDLE', lastTestSentAt: '', productId: '' }];
  },
  // Reads deliberately faster than writes below (realistic for the Sheets
  // API, and needed to make this test deterministic rather than timing-luck
  // dependent): without a shared lock, a read that starts anytime while a
  // write is still in flight will reliably finish first and observe stale
  // data, regardless of small jitter in exactly when it starts.
  async getTargetedClientsRows() {
    await delay(5);
    return rows.map((r) => ({ ...r }));
  },
  async upsertTargetedClient(chatId, fields) {
    await delay(50);
    const existing = rows.find((r) => r.chatId === chatId);
    Object.assign(existing, fields);
  },
  async setLastCampaignTickAt() {},
};
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

const fakeSessions = new Map();
const conversationMemoryStub = {
  getSession(chatId) {
    if (!fakeSessions.has(chatId)) fakeSessions.set(chatId, { chatId, llm: { history: [] } });
    return fakeSessions.get(chatId);
  },
  updateSession(chatId, patch) {
    Object.assign(conversationMemoryStub.getSession(chatId), patch);
  },
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

const productMatcherStub = { getById() { return null; } };
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: productMatcherStub };

delete require.cache[require.resolve('../src/bot/campaignWorker')];
const campaignWorker = require('../src/bot/campaignWorker');

(async () => {
  // Signals the instant sendMessageFn is actually invoked, so the simulated
  // reply below waits for the real causal order (reply can only follow the
  // send reaching the customer) instead of guessing a fixed delay against
  // the tick's own internal timing.
  let resolveSendHappened;
  const sendHappened = new Promise((resolve) => { resolveSendHappened = resolve; });

  // Fire both concurrently: the campaign tick sending+marking OFFER_SENT, and
  // the customer's real reply arriving right after — specifically while the
  // tick's own OFFER_SENT upsert (30ms artificial delay, standing in for a
  // real Sheets round-trip) is still in flight, which is the exact window
  // the audit flagged.
  await Promise.all([
    campaignWorker.runCampaignTick(async () => {
      resolveSendHappened();
    }),
    (async () => {
      await sendHappened;
      // The tick's own continuation past `await sendMessageFn(...)` and into
      // `runExclusive(...)` is a same-microtask synchronous sequence with no
      // further awaits before the lock is registered — this tiny delay just
      // guarantees that continuation has already run before the reply makes
      // its own runExclusive call, so the reply is reliably attempting to
      // acquire the lock *after* the tick already holds it (mid-upsert),
      // not before. Without the P0 fix, this read would still see stale
      // PENDING and silently no-op instead of queuing behind the write.
      await delay(5);
      await campaignWorker.handleInboundMessage(CHAT_ID, 'تمام، حابة أطلبه');
    })(),
  ]);

  const finalRow = rows.find((r) => r.chatId === CHAT_ID);
  assert.strictEqual(finalRow.campaignStatus, 'REPLIED', `expected row to end at REPLIED (reply correctly tracked after the send), got ${finalRow.campaignStatus}`);
  assert.ok(finalRow.repliedAt, 'expected repliedAt to be set');
  console.log('PASS: concurrent campaign-send + real-reply no longer race — reply correctly recorded as REPLIED, not lost at OFFER_SENT.');

  const session = conversationMemoryStub.getSession(CHAT_ID);
  assert.strictEqual(session.llm.history.length, 1, 'expected exactly the offer to be recorded in session history (no clobber)');
  assert.strictEqual(session.llm.history[0].content, 'offer text');
  console.log('PASS: session history correctly retains the campaign offer turn.');

  console.log('\nALL P0 LOCKING TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
