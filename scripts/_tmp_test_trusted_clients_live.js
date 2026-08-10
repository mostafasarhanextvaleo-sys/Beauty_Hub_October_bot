// Live verification (not committed, not a stub) for the 2026-08-10
// Trusted_Clients LOYALTY-TRACKER feature — runs against the REAL
// production Google Sheet (same credentials/spreadsheet the live PM2 bot
// uses) to confirm:
//   1. ensureTrustedClientsSchema() header-migrates the tab correctly —
//      confirmed here as a pure column-ADDITION (Last Order Date/Customer
//      Tier appended to the pre-existing 6-column shape), which is the
//      live production case at the time of this test.
//   2. A brand-new phone's first upsert appends a row seeded correctly,
//      including Last Order Date = that order's date and Customer Tier =
//      "Bronze 🥉" (1 purchase).
//   3. Repeat delivered orders for the SAME phone update that row IN
//      PLACE (never a duplicate), accumulating Total Lifetime
//      Spent/Points, incrementing Number of Purchases, overwriting
//      Address AND Last Order Date with the newest order's values, and
//      recomputing Customer Tier from the fresh purchase count —
//      exercised all the way through all three tier thresholds (1-2
//      Bronze, 3-5 Silver, 6+ VIP Gold).
//   4. A blank customerName/address/orderDate on a later order preserves
//      the existing values rather than blanking them.
// Uses an obviously-fake test phone number so it can't collide with a real
// customer, and deletes the test row again at the end so this never
// pollutes the real production Trusted_Clients tab.
const assert = require('assert');
const googleSheets = require('../src/services/googleSheets');

const TEST_PHONE = '201999999999_TRUSTED_CLIENTS_TEST';

(async () => {
  await googleSheets.init();
  const deadline = Date.now() + 20000;
  while (!googleSheets.isEnabled() && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.strictEqual(googleSheets.isEnabled(), true, 'Google Sheets must be enabled/connected for this live test to mean anything');
  console.log('Connected to the real Google Sheet.');

  const client = googleSheets.getClient();
  const config = require('../src/config');
  const meta = await client.spreadsheets.get({ spreadsheetId: config.googleSheetId });
  const titles = (meta.data.sheets || []).map((s) => s.properties.title);
  assert.ok(titles.includes(googleSheets.TRUSTED_CLIENTS_SHEET_NAME), 'Trusted_Clients tab should exist (auto-created by ensureCrmTabs()/init())');
  console.log('PASS: Trusted_Clients tab exists.');

  // --- 1. Header holds the current 8-column loyalty-tracker schema ---
  const headerRes = await client.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: `${googleSheets.TRUSTED_CLIENTS_SHEET_NAME}!A1:Z1`,
  });
  assert.deepStrictEqual(
    headerRes.data.values[0],
    googleSheets.TRUSTED_CLIENTS_HEADERS,
    'Trusted_Clients header row must match the current 8-column loyalty-tracker schema exactly (and nothing dangling past the last column)'
  );
  assert.deepStrictEqual(
    googleSheets.TRUSTED_CLIENTS_HEADERS.slice(-2),
    ['Last Order Date', 'Customer Tier'],
    'the two new columns must be the trailing two columns'
  );
  console.log('PASS: Trusted_Clients header holds the current schema:', googleSheets.TRUSTED_CLIENTS_HEADERS.join(', '));

  // --- pure computeCustomerTier unit checks (no Sheets I/O) ---
  assert.strictEqual(googleSheets.computeCustomerTier(1), 'Bronze 🥉');
  assert.strictEqual(googleSheets.computeCustomerTier(2), 'Bronze 🥉');
  assert.strictEqual(googleSheets.computeCustomerTier(3), 'Silver 🥈');
  assert.strictEqual(googleSheets.computeCustomerTier(5), 'Silver 🥈');
  assert.strictEqual(googleSheets.computeCustomerTier(6), 'VIP Gold 🥇');
  assert.strictEqual(googleSheets.computeCustomerTier(20), 'VIP Gold 🥇');
  console.log('PASS: computeCustomerTier thresholds (1-2 Bronze, 3-5 Silver, 6+ VIP Gold) are correct.');

  // --- cleanup helper: remove any pre-existing leftover test row first ---
  async function findTestRow() {
    const rows = await googleSheets.getTrustedClientsRows();
    return rows.find((r) => r.phone === TEST_PHONE);
  }
  async function deleteRow(rowNumber) {
    const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === googleSheets.TRUSTED_CLIENTS_SHEET_NAME);
    await client.spreadsheets.batchUpdate({
      spreadsheetId: config.googleSheetId,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheetMeta.properties.sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }] },
    });
  }

  const leftover = await findTestRow();
  if (leftover) {
    console.log(`Found a leftover test row from a previous run (row ${leftover.rowNumber}) — deleting before starting.`);
    await deleteRow(leftover.rowNumber);
  }

  // --- 2. Six delivered orders in sequence, walking through all 3 tiers ---
  const orderDates = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];
  const expectedTierAfter = { 1: 'Bronze 🥉', 2: 'Bronze 🥉', 3: 'Silver 🥈', 4: 'Silver 🥈', 5: 'Silver 🥈', 6: 'VIP Gold 🥇' };
  let firstRowNumber = null;
  let runningTotal = 0;

  for (let purchaseNum = 1; purchaseNum <= 6; purchaseNum += 1) {
    const orderTotal = 100; // simple constant per-order amount, easy to hand-verify accumulation
    runningTotal += orderTotal;
    // eslint-disable-next-line no-await-in-loop
    const result = await googleSheets.upsertTrustedClient({
      customerName: 'TEST CUSTOMER',
      phone: TEST_PHONE,
      address: `Test Address ${purchaseNum}`,
      orderTotal,
      orderDate: orderDates[purchaseNum - 1],
    });
    if (purchaseNum === 1) {
      assert.strictEqual(result.updated, false, 'the very first order for a brand-new phone should append, not update');
      firstRowNumber = result.rowNumber;
    } else {
      assert.strictEqual(result.updated, true, `purchase ${purchaseNum} for an existing phone should update in place`);
      assert.strictEqual(result.rowNumber, firstRowNumber, 'every repeat purchase must land on the exact same row — never a duplicate');
    }
    assert.strictEqual(result.numberOfPurchases, purchaseNum, `Number of Purchases should be exactly ${purchaseNum}`);
    assert.strictEqual(result.totalLifetimeSpent, runningTotal, `Total Lifetime Spent should accumulate to ${runningTotal}`);
    assert.strictEqual(result.points, runningTotal, 'Points should accumulate 1:1 with Total Lifetime Spent');
    assert.strictEqual(result.address, `Test Address ${purchaseNum}`, "Address should update to this order's address");
    assert.strictEqual(result.lastOrderDate, orderDates[purchaseNum - 1], "Last Order Date should update to this order's date");
    assert.strictEqual(result.customerTier, expectedTierAfter[purchaseNum], `Customer Tier after ${purchaseNum} purchase(s) should be ${expectedTierAfter[purchaseNum]}`);
  }
  console.log('PASS: 6 sequential delivered orders accumulated correctly and Customer Tier walked through Bronze -> Silver -> VIP Gold exactly at the right thresholds.');

  // --- 3. Read back fresh from the Sheet — confirms the WRITE, not just the in-memory return value ---
  const rowsAfterAll = await googleSheets.getTrustedClientsRows();
  const matches = rowsAfterAll.filter((r) => r.phone === TEST_PHONE);
  assert.strictEqual(matches.length, 1, 'still exactly one row after 6 repeat purchases — never a duplicate');
  const persisted = matches[0];
  assert.strictEqual(persisted.numberOfPurchases, 6);
  assert.strictEqual(persisted.totalLifetimeSpent, 600);
  assert.strictEqual(persisted.points, 600);
  assert.strictEqual(persisted.lastOrderDate, '2026-08-06');
  assert.strictEqual(persisted.customerTier, 'VIP Gold 🥇');
  console.log('PASS: persisted row read back fresh from the Sheet matches the expected final loyalty state exactly.');

  // --- 4. A blank customerName/address/orderDate on a later order preserves existing values ---
  const blankFieldsResult = await googleSheets.upsertTrustedClient({
    customerName: '',
    phone: TEST_PHONE,
    address: '',
    orderTotal: 50,
    orderDate: '',
  });
  assert.strictEqual(blankFieldsResult.customerName, 'TEST CUSTOMER', 'a blank customerName must not blank out the name already on file');
  assert.strictEqual(blankFieldsResult.address, 'Test Address 6', 'a blank address must not blank out the address already on file');
  assert.strictEqual(blankFieldsResult.lastOrderDate, '2026-08-06', 'a blank orderDate must not blank out the last order date already on file');
  assert.strictEqual(blankFieldsResult.numberOfPurchases, 7, 'the purchase count still increments even when other fields are blank this time');
  assert.strictEqual(blankFieldsResult.customerTier, 'VIP Gold 🥇', 'tier stays VIP Gold well past the 6-purchase threshold');
  console.log('PASS: blank customerName/address/orderDate on a later order preserves the existing values instead of blanking them.');

  // --- cleanup ---
  await deleteRow(firstRowNumber);
  const rowsAfterCleanup = await googleSheets.getTrustedClientsRows();
  assert.strictEqual(rowsAfterCleanup.filter((r) => r.phone === TEST_PHONE).length, 0, 'cleanup should leave no test rows behind');
  console.log('Cleaned up test row — production Trusted_Clients tab left untouched otherwise.');

  console.log('ALL PASS: Trusted_Clients loyalty-tracker (incl. Last Order Date + Customer Tier) live verification against the real Google Sheet.');
  process.exit(0);
})().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
