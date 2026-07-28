const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { runExclusive } = require('../utils/chatLock');

// Persisted counters of which llmAgent.js tier actually served each reply —
// feeds both "وضع السيرفر" (last/typical tier) and "تقرير التوفير" (local
// vs. paid-tier percentage), so the fine-tuning investment's payoff is
// something the admin can actually see rather than infer from vibes.
const STATE_PATH = path.join(__dirname, '..', '..', 'agent_stats_state.json');

let stats = { local: 0, openai: 0, gemini: 0, failed: 0, since: Date.now() };

function load() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (raw && typeof raw === 'object') {
      stats = {
        local: raw.local || 0,
        openai: raw.openai || 0,
        gemini: raw.gemini || 0,
        failed: raw.failed || 0,
        since: raw.since || Date.now(),
      };
    }
  } catch (err) {
    logger.error('Failed to load agent tier-usage stats. Starting from zero.', err);
  }
}
load();

// 2026-07-28: was a synchronous fs.writeFileSync inside this same setImmediate
// debounce, blocking the event loop on every persist — recordTierUsage fires
// on every single customer reply, so this ran far more often than
// conversationMemory.js's equivalent. Brought in line with that file's
// persistSessionsNow: fs.promises so the write never blocks the event loop,
// temp-file+rename so a crash mid-write can't leave a truncated stats file,
// and runExclusive (same per-key lock conversationMemory.js uses) so two
// persists scheduled back-to-back — recordTierUsage can fire again before the
// previous write finishes, under concurrent messages — can't race on the same
// tmpPath.
const PERSIST_LOCK_KEY = '__agent_stats_persist__';

async function persistNow() {
  const tmpPath = `${STATE_PATH}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(stats));
    await fs.promises.rename(tmpPath, STATE_PATH);
  } catch (err) {
    logger.error('Failed to persist agent tier-usage stats.', err);
  }
}

let persistScheduled = false;
function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  setImmediate(() => {
    persistScheduled = false;
    runExclusive(PERSIST_LOCK_KEY, persistNow).catch(() => {});
  });
}

// tierName: 'local' | 'openai' | 'gemini' | 'failed' (all tiers exhausted)
function recordTierUsage(tierName) {
  if (!Object.prototype.hasOwnProperty.call(stats, tierName)) return;
  stats[tierName] += 1;
  schedulePersist();
}

function getStats() {
  return { ...stats };
}

module.exports = { recordTierUsage, getStats };
