// Throwaway verification for deploy item "Clear the pre-checkout backlog
// once Sheets/campaign jobs are healthy again". The ticket's premise is that
// campaignWorker's Send Now / Campaign tick jobs are what re-engage the
// 90-session pre-checkout backlog (RECOMMENDED / AWAIT_ORDER_DETAILS /
// AWAIT_ORDER_CONFIRMATION), and that fixing the Sheets DNS root cause
// (25b3d0d / a36e3ef) should let that backlog clear.
//
// This test checks that premise against the actual code path: the real
// re-engagement mechanism for those three stages is cartRecovery.js's own
// two-nudge scheduler (scanAndSendNudges), which is entirely independent of
// campaignWorker's Send Now/Campaign tick and of Google Sheets health — it
// only reads session.updatedAt/nudgeSentAt and a locally-cached paused/
// blocked flag that fails OPEN (not blocking sends) when Sheets is down.
//
// Simulates Google Sheets being completely down (every googleSheets.* call
// throws, exactly like the DNS outage) and confirms scanAndSendNudges still
// successfully nudges stale pre-checkout sessions regardless.
const assert = require('assert');

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
const conversationMemoryStub = {
  STAGES,
  getSession(chatId) { return fakeSessions.get(chatId); },
  getAllSessions() { return [...fakeSessions.entries()]; },
  updateSession(chatId, patch) {
    Object.assign(fakeSessions.get(chatId), patch);
    return fakeSessions.get(chatId);
  },
  isHumanHandoffCooldownActive() { return false; },
};
require.cache[conversationMemoryPath] = { id: conversationMemoryPath, filename: conversationMemoryPath, loaded: true, exports: conversationMemoryStub };

// Every Sheets call throws — simulates the DNS outage described in the
// ticket (getaddrinfo EAI_AGAIN against sheets.googleapis.com).
const googleSheetsStub = new Proxy({}, { get: () => async () => { throw new Error('getaddrinfo EAI_AGAIN sheets.googleapis.com (simulated outage)'); } });
require.cache[googleSheetsPath] = { id: googleSheetsPath, filename: googleSheetsPath, loaded: true, exports: googleSheetsStub };

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

const cartRecovery = require('../src/bot/cartRecovery');

(async () => {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;

  // Backlog scenario from the ticket: sessions stuck 24h-72h+ in pre-checkout
  // stages, never yet nudged.
  fakeSessions.set('stale_25h@lid', { chatId: 'stale_25h@lid', stage: STAGES.AWAIT_ORDER_CONFIRMATION, updatedAt: now - 25 * HOUR, llm: { history: [] } });
  fakeSessions.set('stale_80h@lid', { chatId: 'stale_80h@lid', stage: STAGES.RECOMMENDED, updatedAt: now - 80 * HOUR, llm: { history: [] } });
  fakeSessions.set('stale_30h_details@lid', { chatId: 'stale_30h_details@lid', stage: STAGES.AWAIT_ORDER_DETAILS, updatedAt: now - 30 * HOUR, llm: { history: [] } });
  // Not pre-checkout — must never be touched.
  fakeSessions.set('closed_session@lid', { chatId: 'closed_session@lid', stage: STAGES.CLOSED, updatedAt: now - 80 * HOUR, llm: { history: [] } });

  const sent = [];
  const sendMessageFn = async (chatId, message) => { sent.push({ chatId, message }); };

  await cartRecovery.scanAndSendNudges(sendMessageFn);

  assert.strictEqual(sent.length, 3, `expected all 3 stale pre-checkout sessions to get nudged despite Sheets being down, got ${sent.length}`);
  assert.ok(sent.some((s) => s.chatId === 'stale_25h@lid'));
  assert.ok(sent.some((s) => s.chatId === 'stale_80h@lid'));
  assert.ok(sent.some((s) => s.chatId === 'stale_30h_details@lid'));
  assert.ok(!sent.some((s) => s.chatId === 'closed_session@lid'), 'CLOSED session must never be nudged');

  console.log('PASS: cartRecovery.scanAndSendNudges nudges the stale pre-checkout backlog even with every Google Sheets call throwing.');
  console.log('This confirms the backlog is NOT gated on campaignWorker Send Now/Campaign tick or Sheets health — those fixes have no effect on this backlog.');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
