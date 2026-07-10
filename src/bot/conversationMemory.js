const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STAGES = {
  NEW: 'NEW',
  AWAIT_CATEGORY: 'AWAIT_CATEGORY',
  AWAIT_ATTRIBUTE: 'AWAIT_ATTRIBUTE',
  RECOMMENDED: 'RECOMMENDED',
  AWAIT_ORDER_DETAILS: 'AWAIT_ORDER_DETAILS',
  AWAIT_ORDER_CONFIRMATION: 'AWAIT_ORDER_CONFIRMATION',
  CLOSED: 'CLOSED',
};

const STATE_PATH = path.join(__dirname, '..', '..', 'sessions_state.json');

const sessions = new Map();
let persistScheduled = false;

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    entries.forEach(([chatId, session]) => sessions.set(chatId, session));
    logger.info(`Restored ${sessions.size} conversation session(s) from sessions_state.json.`);
  } catch (err) {
    logger.error('Failed to load persisted conversation sessions. Starting with empty state.', err);
  }
}

function persistSessionsNow() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify([...sessions.entries()]));
  } catch (err) {
    logger.error('Failed to persist conversation sessions to disk.', err);
  }
}

// Collapses multiple updateSession() calls within the same message-handling
// burst into a single disk write, instead of writing on every call.
function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  setImmediate(() => {
    persistScheduled = false;
    persistSessionsNow();
  });
}

loadPersistedSessions();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      chatId,
      stage: STAGES.NEW,
      greeted: false,
      category: null,
      skinType: null,
      hairType: null,
      recommendedProduct: null,
      shownProductIds: [],
      customerName: null,
      deliveryAddress: null,
      lastStatus: null,
      lastLoggedSignature: null,
      lastLoggedAt: 0,
      nudgeSentAt: null,
      orderConfirmationAttempts: 0,
      updatedAt: Date.now(),
    });
  }
  return sessions.get(chatId);
}

function updateSession(chatId, patch) {
  const session = getSession(chatId);
  Object.assign(session, patch, { updatedAt: Date.now() });
  schedulePersist();
  return session;
}

function resetSession(chatId) {
  sessions.delete(chatId);
  schedulePersist();
}

function getAllSessions() {
  return [...sessions.entries()];
}

module.exports = {
  STAGES,
  getSession,
  updateSession,
  resetSession,
  getAllSessions,
};
