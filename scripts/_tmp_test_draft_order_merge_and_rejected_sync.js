// Verifies two 2026-08-11 store-owner-directed changes to the order
// pipeline, both using the same safe stubbed-module pattern as
// _tmp_test_cart_recovery_independent_of_sheets.js (never touch the real
// Sheets/session state):
//
// 1. campaignWorker.js's handleOrderConfirmed: a second distinct product
//    confirmed while an earlier order for the same phone is still an open
//    draft (Confirmation Status Hold/Pending, not yet Confirmed) must merge
//    into that SAME Confirmed_Orders row (products appended, total summed,
//    invoice regenerated on that row) instead of appending a brand-new row.
// 2. orderPipeline.js's runRejectedStatusSyncCheck: any row whose
//    Confirmation Status reads 'Rejected' gets its Order Status synced to
//    'Rejected' too, and a row that's already in sync (or not Rejected at
//    all) is left untouched.
const assert = require('assert');

const googleSheetsPath = require.resolve('../src/services/googleSheets');
const invoiceServicePath = require.resolve('../src/bot/invoiceService');
const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const productMatcherPath = require.resolve('../src/bot/productMatcher');
const chatLockPath = require.resolve('../src/utils/chatLock');
const adLeadDetectorPath = require.resolve('../src/bot/adLeadDetector');
const orderPipelinePath = require.resolve('../src/bot/orderPipeline');

// --- Scenario 1: draft-order merge (campaignWorker.js) ---
{
  const now = Date.now();
  let confirmedOrdersRows = [
    {
      rowNumber: 10,
      date: new Date(now - 30 * 60 * 1000).toISOString(), // 30 min ago — well within the 6h episode window
      customerName: 'ريماس',
      phone: '201200000001',
      address: 'القاهرة',
      products: 'صن بلوك ديرماتيك SPF 50 (Dermatique Sunblock SPF 50)',
      totalPrice: '200',
      confirmationStatus: 'Hold',
      orderStatus: 'Processing',
    },
  ];
  const calls = { appendConfirmedOrder: [], updateConfirmedOrderItems: [], setConfirmationStatus: [], generateAndAttachInvoice: [] };

  const googleSheetsStub = {
    async getConfirmedOrdersPipelineRows() { return confirmedOrdersRows; },
    async appendConfirmedOrder(order) {
      calls.appendConfirmedOrder.push(order);
      return { rowNumber: 99 };
    },
    async updateConfirmedOrderItems(rowNumber, patch) {
      calls.updateConfirmedOrderItems.push({ rowNumber, ...patch });
      confirmedOrdersRows = confirmedOrdersRows.map((r) => (r.rowNumber === rowNumber ? { ...r, ...patch } : r));
    },
    async setConfirmationStatus(rowNumber, status) {
      calls.setConfirmationStatus.push({ rowNumber, status });
      confirmedOrdersRows = confirmedOrdersRows.map((r) => (r.rowNumber === rowNumber ? { ...r, confirmationStatus: status } : r));
    },
    async initializeOrderPipelineColumns() {},
    async getTargetedClientsRows() { return []; },
    async upsertTargetedClient() {},
  };
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

  const invoiceServiceStub = {
    async generateAndAttachInvoice({ rowNumber }) {
      calls.generateAndAttachInvoice.push(rowNumber);
      return { url: `https://example.test/invoice/${rowNumber}` };
    },
  };
  require.cache[invoiceServicePath] = { id: invoiceServicePath, filename: invoiceServicePath, loaded: true, exports: invoiceServiceStub };

  require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: { getSession: () => ({}), updateSession: () => {} } };
  require.cache[productMatcherPath] = { id: productMatcherPath, filename: productMatcherPath, loaded: true, exports: {} };
  require.cache[chatLockPath] = { id: chatLockPath, filename: chatLockPath, loaded: true, exports: { runExclusive: async (chatId, fn) => fn() } };
  require.cache[adLeadDetectorPath] = { id: adLeadDetectorPath, filename: adLeadDetectorPath, loaded: true, exports: {} };
  require.cache[orderPipelinePath] = { id: orderPipelinePath, filename: orderPipelinePath, loaded: true, exports: { resetConfirmationAskState: () => {} } };

  const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');
  delete require.cache[campaignWorkerPath];
  const campaignWorker = require(campaignWorkerPath);

  (async () => {
    // A second, DIFFERENT product confirmed for the same phone while row 10
    // is still Hold — must merge into row 10, not append a new row.
    await campaignWorker.handleOrderConfirmed('201200000001@lid', {
      customerName: 'ريماس',
      phone: '201200000001',
      address: 'القاهرة',
      products: 'كريم مرطب (Moisturizing Cream)',
      totalPrice: '150',
    });

    assert.strictEqual(calls.appendConfirmedOrder.length, 0, 'must NOT append a new row while an open draft exists');
    assert.strictEqual(calls.updateConfirmedOrderItems.length, 1, 'must update the existing draft row exactly once');
    assert.strictEqual(calls.updateConfirmedOrderItems[0].rowNumber, 10, 'must target the existing open draft row');
    assert.ok(calls.updateConfirmedOrderItems[0].products.includes('صن بلوك ديرماتيك'), 'merged products must keep the original item');
    assert.ok(calls.updateConfirmedOrderItems[0].products.includes('كريم مرطب'), 'merged products must include the new item');
    assert.strictEqual(calls.updateConfirmedOrderItems[0].totalPrice, '350', 'total must be the sum (200 + 150)');
    assert.deepStrictEqual(calls.generateAndAttachInvoice, [10], 'invoice must be regenerated on the SAME row, not a new one');
    assert.strictEqual(calls.setConfirmationStatus.length, 0, 'row was Hold (ask not yet sent) — no need to reopen it, must stay Hold as-is');

    console.log('PASS: scenario 1a — merges a second distinct product into an existing Hold draft row instead of creating a new row.');

    // Reset and test the Pending case — ask already sent, must reopen to Hold.
    confirmedOrdersRows[0] = { ...confirmedOrdersRows[0], confirmationStatus: 'Pending', products: 'صن بلوك ديرماتيك SPF 50 (Dermatique Sunblock SPF 50)', totalPrice: '200' };
    calls.updateConfirmedOrderItems.length = 0;
    calls.setConfirmationStatus.length = 0;
    calls.generateAndAttachInvoice.length = 0;

    await campaignWorker.handleOrderConfirmed('201200000001@lid', {
      customerName: 'ريماس',
      phone: '201200000001',
      address: 'القاهرة',
      products: 'شامبو (Shampoo)',
      totalPrice: '100',
    });

    assert.strictEqual(calls.updateConfirmedOrderItems.length, 1, 'still merges into the same row when Pending');
    assert.deepStrictEqual(calls.setConfirmationStatus, [{ rowNumber: 10, status: 'Hold' }], 'a Pending draft must be reopened to Hold so a fresh, accurate confirm-ask goes out');

    console.log('PASS: scenario 1b — reopens a Pending draft to Hold after merging so the customer is re-asked with the full, correct order.');

    // A brand-new customer (no open draft at all) must still append normally.
    calls.appendConfirmedOrder.length = 0;
    await campaignWorker.handleOrderConfirmed('201299999999@lid', {
      customerName: 'عميلة جديدة',
      phone: '201299999999',
      address: 'الجيزة',
      products: 'غسول (Cleanser)',
      totalPrice: '120',
    });
    assert.strictEqual(calls.appendConfirmedOrder.length, 1, 'a customer with no open draft must still get a brand-new row, unaffected by this change');

    console.log('PASS: scenario 1c — a genuinely new customer/order (no open draft) is completely unaffected, still appends normally.');
  })().then(runScenario2).catch((err) => {
    console.error('TEST FAILED (scenario 1):', err);
    process.exit(1);
  });
}

// --- Scenario 2: Rejected -> Order Status sync (orderPipeline.js) ---
function runScenario2() {
  let rows = [
    { rowNumber: 20, phone: '201211111111', confirmationStatus: 'Rejected', orderStatus: 'Processing' },
    { rowNumber: 21, phone: '201222222222', confirmationStatus: 'Rejected', orderStatus: 'Rejected' }, // already in sync
    { rowNumber: 22, phone: '201233333333', confirmationStatus: 'Confirmed', orderStatus: 'Processing' }, // not rejected — must not touch
  ];
  const setOrderStatusCalls = [];
  const googleSheetsStub2 = {
    async getConfirmedOrdersPipelineRows() { return rows; },
    async setOrderStatus(rowNumber, status) {
      setOrderStatusCalls.push({ rowNumber, status });
      rows = rows.map((r) => (r.rowNumber === rowNumber ? { ...r, orderStatus: status } : r));
    },
  };
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub2 };

  const campaignWorkerPath2 = require.resolve('../src/bot/campaignWorker');
  require.cache[campaignWorkerPath2] = { id: campaignWorkerPath2, filename: campaignWorkerPath2, loaded: true, exports: { isBotPausedForContact: () => false, isContactBlocked: () => false } };
  const invoiceServicePath2 = require.resolve('../src/bot/invoiceService');
  require.cache[invoiceServicePath2] = { id: invoiceServicePath2, filename: invoiceServicePath2, loaded: true, exports: { generateAndAttachInvoice: async () => null } };
  const conversationMemoryPath2 = require.resolve('../src/bot/conversationMemory');
  require.cache[conversationMemoryPath2] = { id: conversationMemoryPath2, filename: conversationMemoryPath2, loaded: true, exports: { isHumanHandoffCooldownActive: () => false, getSession: () => ({}), updateSession: () => {} } };

  delete require.cache[orderPipelinePath];
  const orderPipeline = require(orderPipelinePath);

  return orderPipeline.runRejectedStatusSyncCheck().then(() => {
    assert.deepStrictEqual(setOrderStatusCalls, [{ rowNumber: 20, status: 'Rejected' }], 'must sync exactly the one out-of-sync Rejected row, nothing else');
    assert.strictEqual(rows.find((r) => r.rowNumber === 22).orderStatus, 'Processing', 'a non-rejected row must never be touched');
    console.log('PASS: scenario 2 — Order Status auto-syncs to Rejected exactly when Confirmation Status is Rejected and out of sync, nothing else.');
    console.log('ALL PASS: draft order merge + rejected-status sync.');
    process.exit(0);
  });
}
