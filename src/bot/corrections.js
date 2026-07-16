const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// corrections.json: LIVE, active correction rules — injected into every
// customer-facing system prompt (see llmSystemPrompt.js). corrections_pending.json:
// proposed corrections from chatEvaluator.js awaiting admin review — never
// read by the live prompt. Nothing reaches corrections.json except through
// approveCorrection() below, which only an explicit admin command
// ("اعتماد تصحيح N") triggers — see src/bot/adminCommands.js. This is a
// deliberate gate: an automated evaluator misjudging a conversation should
// never be able to silently change what every future customer sees.
const ACTIVE_PATH = path.join(__dirname, 'corrections.json');
const PENDING_PATH = path.join(__dirname, 'corrections_pending.json');

let activeCache = [];

function loadJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    logger.error(`Failed to read ${filePath}. Treating as empty.`, err);
    return [];
  }
}

function writeJsonArray(filePath, arr) {
  fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
}

// Cached in memory so buildSystemPrompt() (called on every customer message)
// doesn't hit disk each time — refreshed at startup and again right after an
// admin approves a new correction (see approveCorrection below).
function reloadActiveCorrections() {
  activeCache = loadJsonArray(ACTIVE_PATH)
    .map((c) => (typeof c === 'string' ? c : c.rule))
    .filter(Boolean);
  return activeCache;
}
reloadActiveCorrections();

function getActiveCorrections() {
  return activeCache;
}

function getPendingCorrections() {
  return loadJsonArray(PENDING_PATH);
}

// entry: { rule, reason, chatId, evidence } — chatEvaluator.js builds this.
function addPendingCorrection(entry) {
  const pending = loadJsonArray(PENDING_PATH);
  const nextId = pending.length > 0 ? Math.max(...pending.map((p) => p.id || 0)) + 1 : 1;
  pending.push({ id: nextId, createdAt: Date.now(), ...entry });
  writeJsonArray(PENDING_PATH, pending);
  return nextId;
}

// Moves pending correction `id` into the live corrections.json and refreshes
// the in-memory cache immediately — the next customer message already sees
// it, no restart needed. Returns the approved entry, or null if id not found.
function approveCorrection(id) {
  const pending = loadJsonArray(PENDING_PATH);
  const index = pending.findIndex((p) => p.id === id);
  if (index === -1) return null;
  const [approved] = pending.splice(index, 1);

  const active = loadJsonArray(ACTIVE_PATH);
  active.push({ rule: approved.rule, approvedAt: Date.now(), sourceChatId: approved.chatId || null });
  writeJsonArray(ACTIVE_PATH, active);
  writeJsonArray(PENDING_PATH, pending);
  reloadActiveCorrections();
  return approved;
}

function rejectCorrection(id) {
  const pending = loadJsonArray(PENDING_PATH);
  const index = pending.findIndex((p) => p.id === id);
  if (index === -1) return null;
  const [rejected] = pending.splice(index, 1);
  writeJsonArray(PENDING_PATH, pending);
  return rejected;
}

// Bulk counterpart to approveCorrection — moves multiple pending corrections
// into corrections.json in a single read/write of each file instead of one
// pair of reads/writes per id. `ids: null` means "all currently pending".
// Returns { approved, notFound } — notFound lists any requested ids that
// weren't in the pending list (already handled, or never existed).
function approveCorrections(ids) {
  const pending = loadJsonArray(PENDING_PATH);
  const idSet = ids ? new Set(ids) : null;

  const approved = idSet ? pending.filter((p) => idSet.has(p.id)) : pending.slice();
  const remaining = idSet ? pending.filter((p) => !idSet.has(p.id)) : [];

  if (approved.length > 0) {
    const active = loadJsonArray(ACTIVE_PATH);
    for (const a of approved) {
      active.push({ rule: a.rule, approvedAt: Date.now(), sourceChatId: a.chatId || null });
    }
    writeJsonArray(ACTIVE_PATH, active);
    writeJsonArray(PENDING_PATH, remaining);
    reloadActiveCorrections();
  }

  const notFound = idSet ? [...idSet].filter((id) => !approved.some((a) => a.id === id)) : [];
  return { approved, notFound };
}

// Bulk counterpart to rejectCorrection — see approveCorrections above.
function rejectCorrections(ids) {
  const pending = loadJsonArray(PENDING_PATH);
  const idSet = ids ? new Set(ids) : null;

  const rejected = idSet ? pending.filter((p) => idSet.has(p.id)) : pending.slice();
  const remaining = idSet ? pending.filter((p) => !idSet.has(p.id)) : [];

  if (rejected.length > 0) {
    writeJsonArray(PENDING_PATH, remaining);
  }

  const notFound = idSet ? [...idSet].filter((id) => !rejected.some((r) => r.id === id)) : [];
  return { rejected, notFound };
}

module.exports = {
  getActiveCorrections,
  reloadActiveCorrections,
  getPendingCorrections,
  addPendingCorrection,
  approveCorrection,
  rejectCorrection,
  approveCorrections,
  rejectCorrections,
};
