// Verifies the 2026-08-03 P1 sheet-control additions: Bot Paused (this
// contact), Blocked, and Send Now.
const assert = require('assert');

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const productMatcherPath = require.resolve('../src/bot/productMatcher');

const rows = [
  { rowNumber: 2, chatId: 'PAUSED@lid', phoneNumber: '1', customerName: '', category: '', campaignStatus: 'REPLIED', leadSource: '', recencyTier: '', touches: 0, objectionReason: '', optOut: false, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '', offerSent: '', botPaused: true, sendNow: false, blocked: false },
  { rowNumber: 3, chatId: 'BLOCKED@lid', phoneNumber: '2', customerName: '', category: '', campaignStatus: 'DECLINED', leadSource: '', recencyTier: '', touches: 0, objectionReason: '', optOut: false, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '', offerSent: '', botPaused: false, sendNow: false, blocked: true },
  { rowNumber: 4, chatId: 'NORMAL@lid', phoneNumber: '3', customerName: '', category: '', campaignStatus: 'PENDING', leadSource: '', recencyTier: '', touches: 0, objectionReason: '', optOut: false, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '', offerSent: '', botPaused: false, sendNow: false, blocked: false },
  { rowNumber: 5, chatId: 'SENDNOW@lid', phoneNumber: '4', customerName: '', category: '', campaignStatus: 'ON_HOLD', leadSource: '', recencyTier: '', touches: 2, objectionReason: '', optOut: false, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '', offerSent: '', botPaused: false, sendNow: true, blocked: false },
  { rowNumber: 6, chatId: 'OPTOUTSENDNOW@lid', phoneNumber: '5', customerName: '', category: '', campaignStatus: 'DECLINED', leadSource: '', recencyTier: '', touches: 0, objectionReason: '', optOut: true, lastMessageDate: '', sentAt: '', repliedAt: '', orderedAt: '', offerSent: '', botPaused: false, sendNow: true, blocked: false },
];

const upsertCalls = [];
const googleSheetsStub = {
  async getTargetedClientsRows() { return rows.map((r) => ({ ...r })); },
  async getOffersCampaignRows() {
    return [{ rowNumber: 2, offerId: 'OFFER_1', offerName: 'Test Offer', offerText: 'send now offer text', campaignStatus: 'PUSH', testTrigger: 'IDLE', lastTestSentAt: '', productId: '' }];
  },
  async upsertTargetedClient(chatId, fields) {
    upsertCalls.push({ chatId, fields });
    const existing = rows.find((r) => r.chatId === chatId);
    if (existing) Object.assign(existing, fields);
  },
};
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

const fakeSessions = new Map();
const conversationMemoryStub = {
  getSession(chatId) { if (!fakeSessions.has(chatId)) fakeSessions.set(chatId, { chatId, llm: { history: [] } }); return fakeSessions.get(chatId); },
  updateSession(chatId, patch) { Object.assign(conversationMemoryStub.getSession(chatId), patch); },
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

const productMatcherStub = { getById() { return null; } };
require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: productMatcherStub };

delete require.cache[require.resolve('../src/bot/campaignWorker')];
const campaignWorker = require('../src/bot/campaignWorker');

(async () => {
  // --- Bot Paused / Blocked cache ---
  campaignWorker.startPausedContactsAutoRefresh(999999999); // long interval — just need the initial refresh
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the fire-and-forget initial refresh land

  assert.strictEqual(campaignWorker.isBotPausedForContact('PAUSED@lid'), true, 'PAUSED@lid should be paused');
  assert.strictEqual(campaignWorker.isBotPausedForContact('NORMAL@lid'), false, 'NORMAL@lid should not be paused');
  assert.strictEqual(campaignWorker.isContactBlocked('BLOCKED@lid'), true, 'BLOCKED@lid should be blocked');
  assert.strictEqual(campaignWorker.isContactBlocked('NORMAL@lid'), false, 'NORMAL@lid should not be blocked');
  console.log('PASS: Bot Paused / Blocked cache correctly reflects Targeted_Clients rows.');

  // --- Send Now ---
  const sent = [];
  await campaignWorker.runSendNowCheck(async (chatId, text) => { sent.push({ chatId, text }); });

  assert.strictEqual(sent.length, 1, 'expected exactly one send (SENDNOW@lid) — OPTOUTSENDNOW@lid must be skipped');
  assert.strictEqual(sent[0].chatId, 'SENDNOW@lid');
  assert.strictEqual(sent[0].text, 'send now offer text');
  console.log('PASS: Send Now sent the active offer to the triggered contact and correctly skipped the opted-out one.');

  const sendNowRow = rows.find((r) => r.chatId === 'SENDNOW@lid');
  assert.strictEqual(sendNowRow.sendNow, false, 'expected Send Now to be cleared after a successful send');
  assert.strictEqual(sendNowRow.campaignStatus, 'OFFER_SENT', 'expected campaignStatus to be updated to OFFER_SENT');
  assert.strictEqual(sendNowRow.touches, 3, 'expected touches to be incremented');

  const optOutRow = rows.find((r) => r.chatId === 'OPTOUTSENDNOW@lid');
  assert.strictEqual(optOutRow.sendNow, false, 'expected Send Now to be cleared for the opted-out contact too (one-attempt semantics), even though nothing was sent');
  assert.strictEqual(optOutRow.campaignStatus, 'DECLINED', 'expected the opted-out contact\'s status to be untouched');
  console.log('PASS: Send Now flag is cleared after exactly one attempt in both the success and skipped-due-to-optout cases.');

  console.log('\nALL P1 SHEET CONTROL TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
