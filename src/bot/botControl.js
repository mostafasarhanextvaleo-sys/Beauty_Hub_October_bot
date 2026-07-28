const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { runExclusive } = require('../utils/chatLock');

// Persisted (not just in-memory) so a pm2 restart mid-pause can't silently
// resume auto-replies while the admin still thinks they're paused — that
// would be the exact opposite of what "وقف البوت" is for.
const STATE_PATH = path.join(__dirname, '..', '..', 'bot_control_state.json');

let paused = false;

function load() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    paused = Boolean(raw.paused);
    if (paused) {
      logger.warn('Bot auto-replies restored as PAUSED (bot_control_state.json) — send "تشغيل البوت" from the admin number to resume.');
    }
  } catch (err) {
    logger.error('Failed to load bot control state. Defaulting to not-paused.', err);
  }
}
load();

// 2026-07-28: was a synchronous fs.writeFileSync, blocking the event loop
// on every pause/resume. Brought in line with conversationMemory.js's
// persistSessionsNow: fs.promises so the write never blocks, temp-file+rename
// so a crash mid-write can't corrupt this file (the in-memory `paused` flag
// above is already updated synchronously before this runs, so the bot's
// actual reply behavior is never delayed by the disk write — only surviving
// a restart depends on it finishing), and runExclusive so a rapid
// pause/resume/pause from an admin can't race two writes on the same
// tmpPath.
const PERSIST_LOCK_KEY = '__bot_control_persist__';

async function persistNow() {
  const tmpPath = `${STATE_PATH}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify({ paused, updatedAt: Date.now() }));
    await fs.promises.rename(tmpPath, STATE_PATH);
  } catch (err) {
    logger.error('Failed to persist bot control state.', err);
  }
}

function persist() {
  runExclusive(PERSIST_LOCK_KEY, persistNow).catch(() => {});
}

function isPaused() {
  return paused;
}

function setPaused(value) {
  paused = Boolean(value);
  persist();
}

module.exports = { isPaused, setPaused };
