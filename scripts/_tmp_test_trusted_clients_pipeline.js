// Regression check (not committed) for the 2026-08-10 Trusted_Clients
// loyalty-tracker feature: orderPipeline.js's runOrderDeliveredCheck must
// compute a shipping-inclusive order total (via shippingZones.matchShippingZone,
// same as invoiceGenerator.js) and hand it to googleSheets.upsertTrustedClient
// the first time a Confirmed_Orders row is observed as Delivered —
// independently of whether the rating-request DM itself can be sent
// (Blocked/Paused/unresolved chatId must not block the loyalty sync) — and
// must never re-sync the same row on a later poll (no double-counting).
//
// IMPORTANT: orderPipeline.js is required un-stubbed (only its googleSheets/
// conversationMemory/campaignWorker/invoiceService dependencies are stubbed
// below), so it loads/persists its REAL module-level state file
// (order_pipeline_state.json — the same file the live PM2 bot uses,
// STATE_PATH is a hardcoded path with no injection point). A first version
// of this test used rowNumber 2/3/4, which collided with REAL Confirmed_Orders
// rows and wrote bogus deliveredMessageSent/trustedClientSynced flags into
// the PRODUCTION state file — caught and manually reverted once, but the
// robust fix is here: back up the real state file's exact bytes before
// requiring orderPipeline.js and restore them in a finally, so this test can
// never leave the production state file altered no matter what rowNumbers it
// uses or whether an assertion throws partway through. Also uses
// obviously-out-of-range rowNumbers (900001+) as a second, independent layer
// of protection against ever colliding with a real row again.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'order_pipeline_state.json');
const originalStateBytes = fs.existsSync(STATE_PATH) ? fs.readFileSync(STATE_PATH, 'utf-8') : null;

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');
const invoiceServicePath = require.resolve('../src/bot/invoiceService');

// Addresses are real, deterministic shippingZones.js zone-keyword matches so
// the expected orderTotal (product price + real zone feeEGP) can be computed
// by hand here and checked, not just asserted to be "some number":
// القاهرة/الجيزة -> cairo_giza (65 EGP), أكتوبر -> october (50 EGP).
const upsertTrustedClientCalls = [];
const rows = [
  { rowNumber: 900001, date: '2026-08-10T00:00:00.000Z', customerName: 'سارة', phone: '201000000001', address: 'القاهرة', products: 'كريم', totalPrice: '300', invoiceLink: '', sendInvoiceAction: 'Sent', confirmationStatus: 'Confirmed', orderStatus: 'Delivered' },
  { rowNumber: 900002, date: '2026-08-10T00:00:00.000Z', customerName: 'هالة', phone: '201000000002', address: 'الجيزة', products: 'سيروم', totalPrice: '450', invoiceLink: '', sendInvoiceAction: 'Sent', confirmationStatus: 'Confirmed', orderStatus: 'Delivered' },
  { rowNumber: 900003, date: '2026-08-10T00:00:00.000Z', customerName: 'منى', phone: '201000000003', address: 'أكتوبر', products: 'غسول', totalPrice: '150', invoiceLink: '', sendInvoiceAction: 'Sent', confirmationStatus: 'Confirmed', orderStatus: 'Processing' },
];

const googleSheetsStub = {
  async getConfirmedOrdersPipelineRows() { return rows.map((r) => ({ ...r })); },
  async upsertTrustedClient(args) { upsertTrustedClientCalls.push(args); },
};
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

const fakeSessions = new Map();
const conversationMemoryStub = {
  getSession(chatId) { if (!fakeSessions.has(chatId)) fakeSessions.set(chatId, { chatId, llm: { history: [] } }); return fakeSessions.get(chatId); },
  updateSession(chatId, patch) { Object.assign(conversationMemoryStub.getSession(chatId), patch); },
  isHumanHandoffCooldownActive() { return false; },
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

// row 1 (phone ...001) resolves to a chatId that IS Blocked -> no DM, but
// Trusted_Clients sync must still happen. row 2 (...002) resolves normally.
const campaignWorkerStub = {
  isBotPausedForContact() { return false; },
  isContactBlocked(chatId) { return chatId === 'BLOCKED@lid'; },
};
require.cache[campaignWorkerPath] = { id: campaignWorkerPath, filename: campaignWorkerPath, loaded: true, exports: campaignWorkerStub };

const invoiceServiceStub = { async generateAndAttachInvoice() { return { url: 'https://example.test/invoice/2' }; } };
require.cache[invoiceServicePath] = { id: invoiceServicePath, filename: invoiceServicePath, loaded: true, exports: invoiceServiceStub };

delete require.cache[require.resolve('../src/bot/orderPipeline')];
const orderPipeline = require('../src/bot/orderPipeline');

const phoneToChatId = new Map([
  ['201000000001', 'BLOCKED@lid'],
  ['201000000002', 'NORMAL@lid'],
]);
const sentMessages = [];
const sendMessageFn = async (chatId, text) => sentMessages.push({ chatId, text });
const resolvePhoneToChatIdFn = async () => phoneToChatId;

(async () => {
  // --- 1st poll ---
  await orderPipeline.runOrderDeliveredCheck(sendMessageFn, resolvePhoneToChatIdFn);

  assert.strictEqual(upsertTrustedClientCalls.length, 2, 'both Delivered rows (001, 002) should sync — the Processing row (003) must not');
  const call1 = upsertTrustedClientCalls.find((c) => c.phone === '201000000001');
  const call2 = upsertTrustedClientCalls.find((c) => c.phone === '201000000002');
  assert.ok(call1, 'the Blocked contact must still be synced to Trusted_Clients even though it cannot be messaged');
  assert.strictEqual(call1.orderTotal, 365, 'row 1: 300 (product) + 65 (cairo_giza zone fee for القاهرة) = 365');
  assert.strictEqual(call1.address, 'القاهرة', 'address should be passed through as-is');
  assert.strictEqual(call1.orderDate, '2026-08-10T00:00:00.000Z', "orderDate should be passed through from the Confirmed_Orders row's own Date column");
  assert.strictEqual(call2.orderTotal, 515, 'row 2: 450 (product) + 65 (cairo_giza zone fee for الجيزة) = 515');
  assert.strictEqual(sentMessages.length, 1, 'only the non-blocked Delivered contact should receive the rating-request DM');
  assert.strictEqual(sentMessages[0].chatId, 'NORMAL@lid', 'the DM must go to the resolvable, non-blocked contact only');
  console.log('PASS: 1st poll — Trusted_Clients loyalty sync (with correct shipping-inclusive totals) is independent of the messaging guard.');

  // --- 2nd poll: nothing should re-fire ---
  upsertTrustedClientCalls.length = 0;
  sentMessages.length = 0;
  await orderPipeline.runOrderDeliveredCheck(sendMessageFn, resolvePhoneToChatIdFn);
  assert.strictEqual(upsertTrustedClientCalls.length, 0, 'a row already synced must not be re-upserted (re-counted) on a later poll');
  assert.strictEqual(sentMessages.length, 0, 'a row already messaged must not be re-messaged on a later poll');
  console.log('PASS: 2nd poll — already-synced/already-messaged rows do not re-fire (no double-counting).');

  // --- row 3 flips Processing -> Delivered later: must now sync too ---
  rows[2].orderStatus = 'Delivered';
  await orderPipeline.runOrderDeliveredCheck(sendMessageFn, resolvePhoneToChatIdFn);
  assert.strictEqual(upsertTrustedClientCalls.length, 1, 'a row that newly becomes Delivered should sync on its first Delivered poll');
  assert.strictEqual(upsertTrustedClientCalls[0].phone, '201000000003');
  assert.strictEqual(upsertTrustedClientCalls[0].orderTotal, 200, 'row 3: 150 (product) + 50 (october zone fee for أكتوبر) = 200');
  console.log('PASS: a row transitioning into Delivered later syncs correctly, with the right zone fee.');

  console.log('ALL PASS: Trusted_Clients pipeline integration.');
})()
  .catch((err) => {
    console.error('FAIL:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Restore the REAL production order_pipeline_state.json exactly,
    // regardless of pass/fail — see the header comment above.
    if (originalStateBytes === null) {
      if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
    } else {
      fs.writeFileSync(STATE_PATH, originalStateBytes);
    }
    console.log('Restored the real order_pipeline_state.json to its pre-test contents.');
  });
