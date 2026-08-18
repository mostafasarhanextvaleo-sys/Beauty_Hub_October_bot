// Regression test (not committed) for the 2026-08-19 A2 safety guard:
// POST /admin/send-message (src/index.js) now blocks a likely-redundant
// order-confirmation-request admin message when the target chat has no
// order actually awaiting her confirmation right now (session's live
// pendingConfirmedOrderRow, set by orderPipeline.js and cleared by
// llmAgent.js the instant a real تأكيد/رفض reply is processed).
// Confirmed live (chatId 88876412584107@lid, phone 201055990502): a manual
// confirmation-request message was sent 44 seconds after her order was
// already Confirmed.
//
// Boots the REAL src/index.js Express app in-process with every other
// dependency stubbed (Sheets/WhatsApp/schedulers/etc. never touch anything
// real), on a throwaway local port and admin token, then fires real HTTP
// requests at the real route handler — not a reimplementation of its logic.
const assert = require('assert');
const http = require('http');

process.env.PORT = '34599';
process.env.ADMIN_SEND_TOKEN = 'test-admin-token-guard';
process.env.PUBLIC_BASE_URL = 'http://localhost:34599';

const modulesToStub = {
  '../src/services/googleSheets': {
    init: async () => {},
    startStalenessMonitor: () => {},
    isStale: () => false,
    getConfirmedOrderByRowNumber: async () => null,
  },
  '../src/whatsapp/client': {
    createClient: () => {},
    getStatus: () => 'connected',
    sendMessageToChatId: async () => { throw new Error('sendMessageToChatId must never be called for a request the guard should block'); },
    buildPhoneToChatIdMap: async () => ({}),
    resolveRealPhone: async (id) => id,
    destroy: () => {},
    onReady: (cb) => {},
  },
  '../src/bot/productMatcher': {
    refreshFromGoogleSheets: async () => {},
    startAutoRefresh: () => {},
    getSource: () => 'stub',
    getProductCount: () => 0,
    getAllProducts: () => [],
    getById: () => null,
  },
  '../src/bot/productSearch': {
    refreshProductEmbeddings: async () => {},
    startEmbeddingAutoRefresh: () => {},
    isEmbeddingsReady: () => false,
    getEmbeddingCount: () => 0,
  },
  '../src/bot/cartRecovery': { startCartRecoveryScheduler: () => {}, scanAndSendNudges: async () => {} },
  '../src/bot/orderPipeline': {
    startOrderPipelineScheduler: () => {},
    runSendInvoiceActionCheck: async () => {},
    runOrderConfirmationRequestCheck: async () => {},
    runOrderDeliveredCheck: async () => {},
    runRejectedStatusSyncCheck: async () => {},
    runStalledOrderEscalationCheck: async () => {},
    resetConfirmationAskState: () => {},
  },
  '../src/bot/campaignWorker': {
    startPausedContactsAutoRefresh: () => {},
    startCampaignWorker: () => {},
    handleInboundMessage: async () => {},
    captureInboundLead: () => {},
    tagAdLead: () => {},
    handleOrderConfirmed: async () => {},
    runCampaignTick: async () => {},
    runTestTriggerCheck: async () => {},
    appendOfferToSessionHistory: async () => {},
    classifyLeadForCampaign: () => null,
    runSendNowCheck: async () => {},
  },
  '../src/bot/campaignKnowledge': { refresh: async () => {}, startAutoRefresh: () => {}, getActiveOffers: () => [] },
  '../src/bot/deploymentAgent': { handleDeploymentMessage: async () => {}, submitReport: async () => {}, reconcileOnBoot: async () => {} },
  '../src/utils/emailAlert': { sendAlert: () => {} },
};

// Controllable session map for conversationMemory.getSession.
const fakeSessions = new Map();
modulesToStub['../src/bot/conversationMemory'] = {
  getSession(chatId) {
    if (!fakeSessions.has(chatId)) fakeSessions.set(chatId, { chatId, pendingConfirmedOrderRow: null });
    return fakeSessions.get(chatId);
  },
};

for (const [relPath, exports] of Object.entries(modulesToStub)) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function post(path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: 34599, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks || '{}') }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  require('../src/index');
  // Give startExpressServer's app.listen a moment to actually bind.
  await sleep(500);

  const authHeaders = { 'X-Admin-Send-Token': 'test-admin-token-guard' };

  // --- 1. THE exact real bug shape: confirmation-request phrasing, no pending order -> blocked ---
  {
    const res = await post('/admin/send-message', authHeaders, {
      chatId: 'NO_PENDING_ORDER@lid',
      text: 'تأكدي الأوردر بالرد بكلمة تأكيد',
    });
    assert.strictEqual(res.status, 409, `expected a 409 block, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(/already have been confirmed or rejected/.test(res.body.error), 'expected the redundant-confirmation-request error message');
    console.log('PASS: a confirmation-request message to a chat with no order pending confirmation is blocked (409).');
  }

  // --- 2. Same phrasing, but the chat DOES have a real order awaiting her confirmation -> allowed ---
  {
    fakeSessions.set('PENDING_ORDER@lid', { chatId: 'PENDING_ORDER@lid', pendingConfirmedOrderRow: 7 });
    modulesToStub['../src/whatsapp/client'].sendMessageToChatId = async () => {};
    const res = await post('/admin/send-message', authHeaders, {
      chatId: 'PENDING_ORDER@lid',
      text: 'تأكدي الأوردر بالرد بكلمة تأكيد',
    });
    assert.strictEqual(res.status, 200, `expected the send to succeed when an order is genuinely pending confirmation, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.sent, true);
    console.log('PASS: the same phrasing is allowed through when an order is genuinely awaiting her confirmation.');
  }

  // --- 3. force:true overrides the block even with no pending order ---
  {
    const res = await post('/admin/send-message', authHeaders, {
      chatId: 'NO_PENDING_ORDER@lid',
      text: 'تأكدي الأوردر بالرد بكلمة تأكيد',
      force: true,
    });
    assert.strictEqual(res.status, 200, `expected force:true to override the block, got ${res.status}: ${JSON.stringify(res.body)}`);
    console.log('PASS: force:true overrides the guard for a genuinely intentional resend.');
  }

  // --- 4. An ordinary admin message (not confirmation-request phrasing) is never touched by the guard ---
  {
    const res = await post('/admin/send-message', authHeaders, {
      chatId: 'NO_PENDING_ORDER@lid',
      text: 'أهلاً، عندك عرض جديد النهاردة!',
    });
    assert.strictEqual(res.status, 200, `expected an unrelated admin message to go through untouched, got ${res.status}: ${JSON.stringify(res.body)}`);
    console.log('PASS: an ordinary (non-confirmation-request) admin message is completely unaffected by the guard.');
  }

  console.log('\nALL A2 ADMIN-SEND GUARD TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
