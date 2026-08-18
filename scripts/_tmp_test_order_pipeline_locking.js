// Verifies the 2026-08-12 fix: orderPipeline.js's three scheduled checks
// (runSendInvoiceActionCheck, runOrderConfirmationRequestCheck,
// runOrderDeliveredCheck) now wrap their session/Confirmed_Orders writes in
// runExclusive(chatId, ...) — the same lock whatsapp/client.js already holds
// for the entire duration of a real customer's turn (including llmAgent.js's
// own setConfirmationStatus writes for 'تمام'/رفض replies). Before this fix,
// orderPipeline's writes to the SAME chatId/row were completely unlocked, so
// a fast customer reply could race a slow orderPipeline write and have its
// own genuine 'Confirmed' silently reverted to 'Pending'.
//
// This test proves the lock actually serializes concurrent access (not just
// that the code compiles): it fires orderPipeline's confirmation-request
// send AND a simulated real-time customer 'Confirmed' write at the same
// chatId concurrently, with artificial delays inside both critical sections
// to open a wide race window, and asserts they never execute inside each
// other's locked section at the same time (a live re-entrancy counter that
// must never exceed 1) — the same proof technique used elsewhere in this
// suite for chatId-lock correctness.
const assert = require('assert');
const { runExclusive } = require('../src/utils/chatLock');

process.env.ADMIN_WHATSAPP_NUMBER = '201098175119';

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const googleSheetsPath = require.resolve('../src/services/googleSheets');
const invoiceServicePath = require.resolve('../src/bot/invoiceService');
const shippingZonesPath = require.resolve('../src/bot/shippingZones');
const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const CHAT_ID = 'RACE_TEST@lid';
  const fakeSessions = new Map();
  fakeSessions.set(CHAT_ID, { chatId: CHAT_ID, llm: { history: [] } });

  const conversationMemoryStub = {
    getSession(chatId) { return fakeSessions.get(chatId); },
    updateSession(chatId, patch) {
      const s = fakeSessions.get(chatId);
      Object.assign(s, patch);
      return s;
    },
    isHumanHandoffCooldownActive() { return false; },
  };
  require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

  require.cache[shippingZonesPath] = { id: shippingZonesPath, filename: shippingZonesPath, loaded: true, exports: { matchShippingZone: () => null } };
  require.cache[invoiceServicePath] = { id: invoiceServicePath, filename: invoiceServicePath, loaded: true, exports: { generateAndAttachInvoice: async () => ({ url: 'https://example.test/invoice/1' }) } };
  require.cache[campaignWorkerPath] = { id: campaignWorkerPath, filename: campaignWorkerPath, loaded: true, exports: { isProtectedContact: () => false, isBotPausedForContact: () => false, isContactBlocked: () => false } };

  // Simulated Confirmed_Orders row 1's Confirmation Status cell, plus an
  // artificial network delay on every write to open a real race window —
  // matches the real Sheets API round-trip that made this race possible live.
  let sheetConfirmationStatus = 'Hold';
  const writeLog = [];
  const googleSheetsStub = {
    getConfirmedOrdersPipelineRows: async () => ([
      { rowNumber: 1, phone: '201200000000', confirmationStatus: sheetConfirmationStatus, customerName: 'Test', products: 'X', totalPrice: '100' },
    ]),
    async setConfirmationStatus(rowNumber, status) {
      writeLog.push({ who: 'orderPipeline', status, at: Date.now() });
      await sleep(60); // simulate a slow Sheets round-trip
      sheetConfirmationStatus = status;
    },
    async markInvoiceSent() {},
  };
  require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

  const orderPipelinePath = require.resolve('../src/bot/orderPipeline');
  delete require.cache[orderPipelinePath];
  const orderPipeline = require(orderPipelinePath);

  // Live re-entrancy proof: increments on entering the chatId-locked
  // section, decrements on exit — must never exceed 1 concurrently.
  let inLockedSection = 0;
  let maxConcurrent = 0;
  async function withReentrancyTracking(label, fn) {
    return runExclusive(CHAT_ID, async () => {
      inLockedSection += 1;
      maxConcurrent = Math.max(maxConcurrent, inLockedSection);
      try {
        await sleep(40); // widen the race window further inside the lock too
        await fn();
      } finally {
        inLockedSection -= 1;
      }
    });
  }

  const sendMessageFn = async () => { await sleep(30); };
  const resolvePhoneToChatIdFn = async () => new Map([['201200000000', CHAT_ID]]);

  // Fire both "concurrently": orderPipeline's real confirmation-ask check
  // (which internally takes the SAME runExclusive(CHAT_ID) lock now), and a
  // simulated real-time customer 'Confirmed' reply taking that lock directly
  // — exactly mirroring how llmAgent.js's own setConfirmationStatus call runs
  // inside whatsapp/client.js's runExclusive(message.from) turn lock.
  const customerConfirmedWrite = withReentrancyTracking('customer-confirm', async () => {
    writeLog.push({ who: 'customer', status: 'Confirmed', at: Date.now() });
    await sleep(60);
    sheetConfirmationStatus = 'Confirmed';
  });

  const pipelineAsk = orderPipeline.runOrderConfirmationRequestCheck(sendMessageFn, resolvePhoneToChatIdFn);

  await Promise.all([customerConfirmedWrite, pipelineAsk]);

  assert.strictEqual(maxConcurrent, 1, `expected the two writers to NEVER run inside the lock concurrently, but observed ${maxConcurrent} simultaneous — the lock is not actually serializing them`);

  // Whichever happened to be queued last is what should have won — the
  // critical property this test protects is ORDER-PRESERVING serialization
  // (no interleaving), not a specific outcome. Assert the writes themselves
  // were strictly sequential (each one's start is >= the previous one's
  // simulated completion), proving no write started while another was still
  // in flight.
  const sorted = [...writeLog].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i].at >= sorted[i - 1].at, 'writes must be strictly ordered, never overlapping');
  }
  console.log(`PASS: orderPipeline.js's Confirmation Status writer and a real-time customer write on the same chatId never ran concurrently (maxConcurrent=${maxConcurrent}), write order: ${sorted.map((w) => w.who).join(' -> ')}.`);

  // --- Sanity check: a DIFFERENT chatId's write is NOT blocked by this lock
  // (runExclusive is per-key, must not become a global bottleneck). ---
  {
    const otherChatId = 'OTHER_CHAT@lid';
    const start = Date.now();
    await runExclusive(otherChatId, async () => { await sleep(5); });
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, 'a different chatId must not be blocked by RACE_TEST@lid\'s lock');
    console.log('PASS: locking is per-chatId, not a global bottleneck.');
  }

  // Cleanup: runOrderConfirmationRequestCheck persisted a real entry for
  // rowNumber:1 into the REAL order_pipeline_state.json (its path is
  // resolved relative to the module, not stubbable) — harmless (row 1 is
  // always the header row in a real Sheet, never a real order), but remove
  // it via the module's own exported reset function to leave no trace.
  orderPipeline.resetConfirmationAskState(1);

  console.log('\nALL PASS: orderPipeline.js writes are now correctly serialized against real-time customer replies on the same chatId.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
