const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { runExclusive } = require('../utils/chatLock');

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

// Exactly 1 full day, per the store owner's spec (2026-07-16): once a
// customer is handed to a human agent, the bot stays completely silent for
// this customer — no LLM replies, no automated nudges/follow-ups, nothing —
// so the human agent has the conversation entirely to themselves.
const HUMAN_HANDOFF_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isHumanHandoffCooldownActive(session) {
  return Boolean(session && session.humanHandoffAt && Date.now() - session.humanHandoffAt < HUMAN_HANDOFF_COOLDOWN_MS);
}

// 2026-08-09 order-management pipeline (see orderPipeline.js) — a
// confirmation-request or delivery+rating-request left unanswered for this
// long is treated as stale rather than something a reply days later should
// still be interpreted against. Same window/shape as the retired
// isDeliveryFeedbackExpired this replaces.
const ORDER_CONFIRMATION_REPLY_WINDOW_MS = 48 * 60 * 60 * 1000;
const FEEDBACK_RATING_WINDOW_MS = 48 * 60 * 60 * 1000;

function isOrderConfirmationReplyExpired(session) {
  return Boolean(
    session &&
      session.awaitingOrderConfirmationReply &&
      session.orderConfirmationRequestedAt &&
      Date.now() - session.orderConfirmationRequestedAt >= ORDER_CONFIRMATION_REPLY_WINDOW_MS
  );
}

function isFeedbackRatingExpired(session) {
  return Boolean(
    session &&
      session.awaitingFeedbackRating &&
      session.feedbackRequestedAt &&
      Date.now() - session.feedbackRequestedAt >= FEEDBACK_RATING_WINDOW_MS
  );
}

const sessions = new Map();
let persistScheduled = false;

// One-time migration (2026-07-18): session.llm.history used to be stored in
// Gemini's dialect ({role: 'user'|'model', parts: [{text}]}) since Gemini was
// the original agent backend. The canonical shape is now OpenAI's
// {role: 'user'|'assistant', content} (see llmAgent.js's pushHistory) — every
// already-persisted session predates that switch, so without this they'd feed
// `content: undefined` into the live OpenAI/local calls on their very next
// message.
function migrateLegacyHistoryEntry(turn) {
  if (typeof turn.content === 'string') return turn;
  const text = (turn.parts || []).map((p) => p.text).join('\n');
  return { role: turn.role === 'model' ? 'assistant' : 'user', content: text };
}

function loadPersistedSessions() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    entries.forEach(([chatId, session]) => {
      if (session.llm && Array.isArray(session.llm.history)) {
        session.llm.history = session.llm.history.map(migrateLegacyHistoryEntry);
      }
      sessions.set(chatId, session);
    });
    logger.info(`Restored ${sessions.size} conversation session(s) from sessions_state.json.`);
  } catch (err) {
    logger.error('Failed to load persisted conversation sessions. Starting with empty state.', err);
  }
}

// 2026-07-18 audit: sessions never got evicted, and every message wrote the
// entire session Map back to disk — cost grows without bound the longer the
// store operates, purely as a function of total customers ever seen, not
// current traffic. 30 days of no activity is well past any conversation
// continuity value (the returning-customer memory feature reads order
// history straight from Google Sheets independently of this — see
// buildCustomerProfile — so evicting the live session here loses no
// business-critical data, only in-progress conversational state that's
// meaningless a month later anyway).
const SESSION_EVICTION_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// 2026-08-08: action item from the health-diagnostic report — sessions idle
// 72h+ were piling up in scheduledReport.js's stale24/stale72 pre-checkout
// counts forever, because nothing ever moved them out of their in-progress
// stage label. That backlog looked scarier than it was: item #6 in
// pending_confirmations.json (2026-08-07) already confirmed cartRecovery.js
// independently re-engages every nudge-eligible stale session on its own
// 3h/24h schedule regardless of this — by 72h a session has either already
// had both nudges with no reply (a normal terminal outcome, not "stuck"), or
// was never nudge-eligible to begin with. This doesn't delete anything (that's
// evictStaleSessions' job at 30 days) — it just relabels stage as CLOSED so
// scheduledReport.js's `isPreCheckout` (which already excludes CLOSED) stops
// counting a resolved/abandoned conversation as live backlog. Also fixes the
// pre-existing cosmetic gap item #7 flagged: an orderPlaced session whose
// stage never got advanced to CLOSED now gets swept up here too, same as any
// other idle session. Setting stage alone never silences the bot for a
// returning customer — see whatsapp/client.js:604, which gates replies only
// on humanHandoffAt (a 24h cooldown), never on session.stage — so a customer
// who messages again after archival gets a normal reply, not silence.
const SESSION_ARCHIVE_THRESHOLD_MS = 72 * 60 * 60 * 1000; // 72 hours

function archiveStaleSessions() {
  const cutoff = Date.now() - SESSION_ARCHIVE_THRESHOLD_MS;
  let archived = 0;
  for (const [, session] of sessions) {
    if (session.stage === STAGES.CLOSED) continue;
    if ((session.updatedAt || 0) >= cutoff) continue;
    session.stage = STAGES.CLOSED;
    session.archivedAt = Date.now();
    archived += 1;
  }
  if (archived > 0) {
    logger.info(`Auto-archived ${archived} session(s) idle 72h+ (marked CLOSED, not deleted).`);
  }
}

function evictStaleSessions() {
  const cutoff = Date.now() - SESSION_EVICTION_THRESHOLD_MS;
  let evicted = 0;
  for (const [chatId, session] of sessions) {
    if ((session.updatedAt || 0) < cutoff) {
      sessions.delete(chatId);
      evicted += 1;
    }
  }
  if (evicted > 0) {
    logger.info(`Evicted ${evicted} session(s) inactive for 30+ days from the in-memory store.`);
  }
}

// Non-atomic writeFileSync directly to STATE_PATH used to mean a crash/kill
// mid-write (OOM, host reboot, pm2 hard-stop) left a truncated/corrupt file
// — loadPersistedSessions' catch-all would then silently start every
// customer over from empty state, with no alert beyond a log line. Writing
// to a temp file first and renaming is atomic on the same filesystem (POSIX
// guarantee), so the live STATE_PATH is either the last fully-written good
// version or the new one — never a half-written one.
//
// 2026-07-18 audit (part 2): the sync writeFileSync/renameSync above blocked
// the entire event loop while it ran — measured 7ms at a simulated 50x/1200-
// session load, freezing every concurrent customer's in-flight request for
// that window on every persist. Switched to fs.promises so it no longer
// blocks. That reintroduces a race the synchronous version got "for free"
// from Node's single-threaded blocking I/O: two overlapping async persists
// could both write the same tmpPath concurrently. persistSessionsNow is
// therefore never called directly — only via runPersistExclusive below,
// which reuses chatLock.js's runExclusive (same proven per-key serialization
// already used for per-chat message handling) with a fixed key, so a second
// persist request always waits for the current one to finish rather than
// racing it.
async function persistSessionsNow() {
  archiveStaleSessions();
  evictStaleSessions();
  const tmpPath = `${STATE_PATH}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify([...sessions.entries()]));
    await fs.promises.rename(tmpPath, STATE_PATH);
  } catch (err) {
    logger.error('Failed to persist conversation sessions to disk.', err);
  }
}

const PERSIST_LOCK_KEY = '__sessions_state_persist__';

function runPersistExclusive() {
  return runExclusive(PERSIST_LOCK_KEY, persistSessionsNow);
}

// Collapses multiple updateSession() calls within the same message-handling
// burst into a single disk write, instead of writing on every call.
function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  setImmediate(() => {
    persistScheduled = false;
    runPersistExclusive().catch(() => {});
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
      secondNudgeSentAt: null,
      orderConfirmationAttempts: 0,
      // --- LLM agent (src/bot/llmAgent.js) fields — unused/dormant in 'rules' mode ---
      orderData: { customerName: null, deliveryAddress: null, altPhone: null, locationLink: null },
      noProgressTurns: 0,
      humanHandover: false,
      // Timestamp of the most recent human handoff (explicit request or the
      // LLM's own judgment) — see isHumanHandoffCooldownActive above. Not
      // cleared when the cooldown expires; a new handoff just overwrites it.
      humanHandoffAt: null,
      orderPlaced: false,
      // Product ids already confirmed this session (llmAgent.js's
      // applyValidatedOutput) — lets a genuinely new, different product
      // confirm even after orderPlaced is stuck true from an earlier order,
      // while still blocking the model re-asserting the SAME order's
      // confirmed:true on later turns (2026-08-06 fix).
      confirmedProductIds: [],
      // 2026-08-09 order-management pipeline (see orderPipeline.js). Set by
      // runOrderConfirmationRequestCheck when the confirm-your-order+invoice
      // message is sent; llmAgent.js checks this on the customer's next
      // reply to know whether to interpret it via
      // orderConfirmationReplyDetector.js rather than as a normal message.
      // Cleared once a reply is classified, or once stale (see
      // isOrderConfirmationReplyExpired above).
      awaitingOrderConfirmationReply: false,
      orderConfirmationRequestedAt: null,
      // Which Confirmed_Orders row this ask was about — needed so a matched
      // reply knows which row's Confirmation Status to flip to 'Confirmed'.
      pendingConfirmedOrderRow: null,
      // Set by runOrderDeliveredCheck when the combined delivery-confirmation
      // + rating-request message is sent; llmAgent.js checks this on the
      // customer's next reply via feedbackRatingDetector.js. Cleared once a
      // rating is found, or once stale (see isFeedbackRatingExpired above).
      awaitingFeedbackRating: false,
      feedbackRequestedAt: null,
      // Which Confirmed_Orders row this rating is about — needed to look up
      // the customer's name fresh when writing to the Feedback tab.
      feedbackOrderRowNumber: null,
      llm: { history: [] },
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
  HUMAN_HANDOFF_COOLDOWN_MS,
  isHumanHandoffCooldownActive,
  ORDER_CONFIRMATION_REPLY_WINDOW_MS,
  isOrderConfirmationReplyExpired,
  FEEDBACK_RATING_WINDOW_MS,
  isFeedbackRatingExpired,
};
