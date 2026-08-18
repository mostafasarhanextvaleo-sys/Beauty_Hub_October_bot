// Regression test (not committed) for the 2026-08-19 B2 safety guard:
// orderPipeline.js's runOrderConfirmationRequestCheck now waits
// ORDER_CONFIRMATION_ASK_GRACE_MS (2 min) after a Confirmed_Orders row's own
// creation Date before sending the deterministic confirm-ask, so it doesn't
// immediately double-fire right on top of Sara's own conversational
// "your order is on its way" reply from the same turn. Confirmed live
// (chatId 88876412584107@lid, phone 201055990502): the ask landed just 27
// seconds after Sara's own reply already sounded like the order was done.
const assert = require('assert');

process.env.ADMIN_WHATSAPP_NUMBER = '201098175119';

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const googleSheetsPath = require.resolve('../src/services/googleSheets');
const invoiceServicePath = require.resolve('../src/bot/invoiceService');
const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');

const conversationMemoryStub = {
  isHumanHandoffCooldownActive: () => false,
  getSession: () => ({}),
  updateSession: () => {},
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

const campaignWorkerStub = {
  isProtectedContact: () => false,
  isBotPausedForContact: () => false,
  isContactBlocked: () => false,
};
require.cache[campaignWorkerPath] = { id: campaignWorkerPath, filename: campaignWorkerPath, loaded: true, exports: campaignWorkerStub };

const invoiceServiceStub = { generateAndAttachInvoice: async ({ rowNumber }) => ({ url: `http://example.test/invoice/${rowNumber}` }) };
require.cache[invoiceServicePath] = { id: invoiceServicePath, filename: invoiceServicePath, loaded: true, exports: invoiceServiceStub };

let confirmedOrdersRows = [];
const confirmationStatusWrites = [];
const googleSheetsStub = {
  getConfirmedOrdersPipelineRows: async () => confirmedOrdersRows.map((r) => ({ ...r })),
  setConfirmationStatus: async (rowNumber, status) => { confirmationStatusWrites.push({ rowNumber, status }); },
};
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

delete require.cache[require.resolve('../src/bot/orderPipeline')];
const orderPipeline = require('../src/bot/orderPipeline');

function isoMinutesAgo(min) { return new Date(Date.now() - min * 60 * 1000).toISOString(); }

(async () => {
  // --- 1. Row created 30s ago (within the 2-min grace window) -> NOT sent yet ---
  {
    confirmedOrdersRows = [{ rowNumber: 101, phone: '201000000010', confirmationStatus: 'Hold', date: new Date(Date.now() - 30 * 1000).toISOString(), customerName: 'test', products: 'p', totalPrice: '100' }];
    const sent = [];
    await orderPipeline.runOrderConfirmationRequestCheck(
      async (chatId, text) => sent.push({ chatId, text }),
      async () => new Map([['201000000010', 'CHAT_101@lid']])
    );
    assert.strictEqual(sent.length, 0, 'expected NO confirmation-ask send for a row still inside the 2-minute grace window');
    assert.strictEqual(confirmationStatusWrites.length, 0, 'expected no Confirmation Status write yet either');
    console.log('PASS: a row created 30s ago is correctly held back — inside the grace window.');
  }

  // --- 2. Same row, now 3 minutes old (past the grace window) -> sent ---
  {
    confirmedOrdersRows = [{ rowNumber: 101, phone: '201000000010', confirmationStatus: 'Hold', date: new Date(Date.now() - 3 * 60 * 1000).toISOString(), customerName: 'test', products: 'p', totalPrice: '100' }];
    const sent = [];
    await orderPipeline.runOrderConfirmationRequestCheck(
      async (chatId, text) => sent.push({ chatId, text }),
      async () => new Map([['201000000010', 'CHAT_101@lid']])
    );
    assert.strictEqual(sent.length, 1, 'expected the confirmation-ask to be sent once the grace window has passed');
    assert.strictEqual(sent[0].chatId, 'CHAT_101@lid');
    assert.ok(confirmationStatusWrites.some((w) => w.rowNumber === 101 && w.status === 'Pending'), 'expected Confirmation Status flipped Hold -> Pending');
    console.log('PASS: the same row is correctly sent once it is past the 2-minute grace window.');
  }

  // --- 3. A row with an unparseable/missing date is sent immediately (fail open, not silently stuck forever) ---
  {
    orderPipeline.resetConfirmationAskState(202);
    confirmedOrdersRows = [{ rowNumber: 202, phone: '201000000020', confirmationStatus: 'Hold', date: '', customerName: 'test2', products: 'p2', totalPrice: '200' }];
    const sent = [];
    await orderPipeline.runOrderConfirmationRequestCheck(
      async (chatId, text) => sent.push({ chatId, text }),
      async () => new Map([['201000000020', 'CHAT_202@lid']])
    );
    assert.strictEqual(sent.length, 1, 'expected a row with an unparseable creation date to fail open (sent immediately), not get stuck forever');
    console.log('PASS: an unparseable/missing row date fails open instead of blocking the ask forever.');
  }

  // --- 4. Already-asked rows (confirmationAskSent) are still never re-sent, regardless of age ---
  {
    confirmedOrdersRows = [{ rowNumber: 101, phone: '201000000010', confirmationStatus: 'Hold', date: new Date(Date.now() - 10 * 60 * 1000).toISOString(), customerName: 'test', products: 'p', totalPrice: '100' }];
    const sent = [];
    await orderPipeline.runOrderConfirmationRequestCheck(
      async (chatId, text) => sent.push({ chatId, text }),
      async () => new Map([['201000000010', 'CHAT_101@lid']])
    );
    assert.strictEqual(sent.length, 0, 'expected no re-send for a row already marked confirmationAskSent, regardless of the grace window');
    console.log('PASS: an already-asked row is never re-asked, independent of the new grace-window logic.');
  }

  console.log('\nALL B2 CONFIRMATION-ASK GRACE WINDOW TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
