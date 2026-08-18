// Verifies the 2026-08-12 store-owner directive: the two protected
// admin/test numbers (Main 201098175119, Secondary 201156630487) must never
// be auto-suppressed by the human-handoff cooldown / humanHandover flag,
// under any circumstances — covers whatsapp/client.js's core reply gate
// (via cartRecovery.js/orderPipeline.js, which share the same
// campaignWorker.isProtectedContact check whatsapp/client.js uses; client.js
// itself isn't unit-testable here, it's puppeteer-coupled like every other
// test in this suite already avoids). Reproduces the exact live bug found in
// production logs: row 9 (201156630487) stuck forever on "customer is in
// the 24h human handoff cooldown — not sending."
const assert = require('assert');

process.env.ADMIN_WHATSAPP_NUMBER = '201098175119';
const MAIN = '201098175119';
const SECONDARY = '201156630487';
const HOUR = 60 * 60 * 1000;

const conversationMemoryPath = require.resolve('../src/bot/conversationMemory');
const googleSheetsPath = require.resolve('../src/services/googleSheets');
const openaiServicePath = require.resolve('../src/services/openaiService');
const geminiServicePath = require.resolve('../src/services/geminiService');
const productSearchPath = require.resolve('../src/bot/productSearch');
const campaignKnowledgePath = require.resolve('../src/bot/campaignKnowledge');
const routineBundlesPath = require.resolve('../src/bot/routineBundles');
const trainingDataLoggerPath = require.resolve('../src/utils/trainingDataLogger');
const agentStatsPath = require.resolve('../src/bot/agentStats');

const STAGES = { NEW: 'NEW', AWAIT_CATEGORY: 'AWAIT_CATEGORY', AWAIT_ATTRIBUTE: 'AWAIT_ATTRIBUTE', RECOMMENDED: 'RECOMMENDED', AWAIT_ORDER_DETAILS: 'AWAIT_ORDER_DETAILS', AWAIT_ORDER_CONFIRMATION: 'AWAIT_ORDER_CONFIRMATION', CLOSED: 'CLOSED' };

const fakeSessions = new Map();
// Faithful replica of the real conversationMemory.isHumanHandoffCooldownActive
// (not a stub that always returns false) so this test actually exercises
// real cooldown timing, not just the exemption bypassing a no-op.
function isHumanHandoffCooldownActive(session) {
  return Boolean(session && session.humanHandoffAt && Date.now() - session.humanHandoffAt < 24 * HOUR);
}
const conversationMemoryStub = {
  STAGES,
  getSession(chatId) { return fakeSessions.get(chatId); },
  getAllSessions() { return [...fakeSessions.entries()]; },
  updateSession(chatId, patch) {
    Object.assign(fakeSessions.get(chatId), patch);
    return fakeSessions.get(chatId);
  },
  isHumanHandoffCooldownActive,
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

const openaiServiceStub = { async generateStructuredReply() { return null; } };
require.cache[openaiServicePath] = { id: openaiServicePath, filename: openaiServicePath, loaded: true, exports: openaiServiceStub };
const geminiServiceStub = { async generateStructuredReply() { return null; } };
require.cache[geminiServicePath] = { id: geminiServicePath, filename: geminiServicePath, loaded: true, exports: geminiServiceStub };
const productSearchStub = { async searchProducts() { return []; } };
require.cache[productSearchPath] = { id: productSearchPath, filename: productSearchPath, loaded: true, exports: productSearchStub };
const campaignKnowledgeStub = { getActiveOffers() { return []; } };
require.cache[campaignKnowledgePath] = { id: campaignKnowledgePath, filename: campaignKnowledgePath, loaded: true, exports: campaignKnowledgeStub };
const routineBundlesStub = { getBundleComplement() { return null; }, BUNDLE_DISCOUNT_PERCENT: 10 };
require.cache[routineBundlesPath] = { id: routineBundlesPath, filename: routineBundlesPath, loaded: true, exports: routineBundlesStub };
const trainingDataLoggerStub = { logTrainingExample() {} };
require.cache[trainingDataLoggerPath] = { id: trainingDataLoggerPath, filename: trainingDataLoggerPath, loaded: true, exports: trainingDataLoggerStub };
const agentStatsStub = { recordTierUsage() {}, getStats() { return {}; } };
require.cache[agentStatsPath] = { id: agentStatsPath, filename: agentStatsPath, loaded: true, exports: agentStatsStub };

(async () => {
  // --- Scenario 1: cartRecovery.scanAndSendNudges — a protected number with
  // humanHandover=true AND an active humanHandoffAt cooldown must still get
  // nudged; an identical real customer must not. ---
  {
    const now = Date.now();
    fakeSessions.clear();
    fakeSessions.set(`${MAIN}@c.us`, {
      chatId: `${MAIN}@c.us`, stage: STAGES.AWAIT_ORDER_CONFIRMATION, updatedAt: now - 25 * HOUR,
      humanHandover: true, humanHandoffAt: now - HOUR, llm: { history: [] },
    });
    fakeSessions.set('201200000001@c.us', {
      chatId: '201200000001@c.us', stage: STAGES.AWAIT_ORDER_CONFIRMATION, updatedAt: now - 25 * HOUR,
      humanHandover: true, humanHandoffAt: now - HOUR, llm: { history: [] },
    });

    const googleSheetsStub = new Proxy({}, { get: () => async () => ({ rows: [] }) });
    require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };
    const cartRecoveryPath = require.resolve('../src/bot/cartRecovery');
    delete require.cache[cartRecoveryPath];
    const campaignWorkerPath = require.resolve('../src/bot/campaignWorker');
    delete require.cache[campaignWorkerPath];
    const cartRecovery = require(cartRecoveryPath);

    const sent = [];
    await cartRecovery.scanAndSendNudges(async (chatId, message) => sent.push({ chatId, message }));

    assert.ok(sent.some((s) => s.chatId === `${MAIN}@c.us`), 'protected main number must still be nudged despite humanHandover+active cooldown');
    assert.ok(!sent.some((s) => s.chatId === '201200000001@c.us'), 'a real customer in the identical state must NOT be nudged (unaffected by this change)');
    console.log('PASS: scenario 1 — cartRecovery nudges the protected number through humanHandover+cooldown, real customers unaffected.');
  }

  // --- Scenario 2: orderPipeline.runSendInvoiceActionCheck — reproduces the
  // exact live bug (row 9, secondary number stuck on handoff cooldown) and
  // confirms it now sends. ---
  {
    const now = Date.now();
    fakeSessions.clear();
    fakeSessions.set(`${SECONDARY}@lid`, { chatId: `${SECONDARY}@lid`, humanHandoffAt: now - HOUR, humanHandover: false });
    fakeSessions.set('201200000002@lid', { chatId: '201200000002@lid', humanHandoffAt: now - HOUR, humanHandover: false });

    const invoiceServicePath = require.resolve('../src/bot/invoiceService');
    const invoiceServiceStub = { async generateAndAttachInvoice() { return { link: 'https://example.com/invoice/1' }; } };
    require.cache[invoiceServicePath] = { id: invoiceServicePath, filename: invoiceServicePath, loaded: true, exports: invoiceServiceStub };

    const googleSheetsStub2 = {
      getConfirmedOrdersPipelineRows: async () => ([
        { rowNumber: 9, phone: SECONDARY, sendInvoiceAction: 'Send Invoice', confirmationStatus: '' },
        { rowNumber: 10, phone: '201200000002', sendInvoiceAction: 'Send Invoice', confirmationStatus: '' },
      ]),
      setConfirmedOrderConfirmationStatus: async () => {},
      setSendInvoiceAction: async () => {},
      markInvoiceSent: async () => {},
    };
    require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub2 };

    const orderPipelinePath = require.resolve('../src/bot/orderPipeline');
    delete require.cache[orderPipelinePath];
    const campaignWorkerPath2 = require.resolve('../src/bot/campaignWorker');
    delete require.cache[campaignWorkerPath2];
    const orderPipeline = require(orderPipelinePath);

    const sent = [];
    const sendMessageFn = async (chatId, message) => sent.push({ chatId, message });
    const resolvePhoneToChatIdFn = async () => new Map([[SECONDARY, `${SECONDARY}@lid`], ['201200000002', '201200000002@lid']]);

    await orderPipeline.runSendInvoiceActionCheck(sendMessageFn, resolvePhoneToChatIdFn);

    assert.ok(sent.some((s) => s.chatId === `${SECONDARY}@lid`), 'the protected secondary number (the exact live-stuck row 9) must now receive its invoice despite the active handoff cooldown');
    assert.ok(!sent.some((s) => s.chatId === '201200000002@lid'), 'a real customer in the identical cooldown state must still be held back (unaffected by this change)');
    console.log('PASS: scenario 2 — orderPipeline.runSendInvoiceActionCheck delivers to the protected secondary number, reproducing and fixing the exact live-stuck row 9 case.');
  }

  console.log('ALL PASS: human-handoff cooldown exemption for the two protected numbers, real customers completely unaffected.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
