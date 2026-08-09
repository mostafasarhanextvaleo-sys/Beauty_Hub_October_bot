// Cron entry point (2026-08-06) — run 3x/day (04:00/08:00/18:00 Cairo local
// time) by the system crontab, NOT by PM2 and NOT part of the live bot
// process. Gathers deterministic stats since the last report, makes ONE
// no-tool-access headless `claude -p` call to turn them into a prioritized
// action list, emails the full report, then hands the action items off to
// the ALREADY-RUNNING live bot via POST /admin/submit-report — this script
// never writes pending_confirmations.json directly (src/bot/deploymentAgent.js
// is its sole writer, avoiding a cross-process lost-update race) and never
// touches whatsapp-web.js directly (a second Puppeteer session against the
// same linked-device auth risks corrupting the live one).
//
// Deliberately scoped to AGGREGATES only (counts, system-generated log
// lines, git summaries) — never raw customer chat text. That text is
// unsanitized (chatLogger.js logs it verbatim) and summarizing it into an
// action item would hand attacker-controlled content to the tool-enabled
// draft agent two steps downstream. If a report ever needs to flag a
// specific concerning conversation, that belongs in the emailed report for
// a human to read, not in an actionItem.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const fetch = require('node-fetch');
const config = require('../src/config');
const emailAlert = require('../src/utils/emailAlert');

const REPO_ROOT = path.join(__dirname, '..');
const PENDING_CONFIRMATIONS_PATH = path.join(REPO_ROOT, 'pending_confirmations.json');
const SESSIONS_STATE_PATH = path.join(REPO_ROOT, 'sessions_state.json');
const CHAT_HISTORY_LOG_PATH = path.join(REPO_ROOT, 'chat_history.log');
const PM2_ERROR_LOG_PATH = '/root/.pm2/logs/beauty-hub-bot-error.log';
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // first-ever run: look back 24h

function getWindowStart() {
  try {
    const raw = JSON.parse(fs.readFileSync(PENDING_CONFIRMATIONS_PATH, 'utf-8'));
    if (raw && raw.lastReportAt) return new Date(raw.lastReportAt);
  } catch (err) {
    // File doesn't exist yet or is unreadable — fine, this is the first run.
  }
  return new Date(Date.now() - DEFAULT_WINDOW_MS);
}

function gatherPm2ErrorStats(windowStart) {
  if (!fs.existsSync(PM2_ERROR_LOG_PATH)) return { count: 0, sample: [] };
  const lines = fs.readFileSync(PM2_ERROR_LOG_PATH, 'utf-8').split('\n');
  const tsRe = /\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/;
  const recent = lines.filter((line) => {
    const m = line.match(tsRe);
    if (!m) return false;
    return new Date(m[1]) >= windowStart;
  });
  // Strip ANSI color codes before sampling so the LLM prompt isn't full of
  // escape sequences — this is system-generated log text, not customer input.
  const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const sample = recent.slice(0, 30).map(clean);
  return { count: recent.length, sample };
}

function gatherSessionStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_STATE_PATH, 'utf-8'));
    const now = Date.now();
    const stageCounts = {};
    let stale24 = 0;
    let stale72 = 0;
    let preCheckout = 0;
    raw.forEach(([, session]) => {
      stageCounts[session.stage] = (stageCounts[session.stage] || 0) + 1;
      const ageMs = now - (session.updatedAt || 0);
      const isPreCheckout = session.stage !== 'AWAIT_ORDER_CONFIRMATION' && session.stage !== 'CLOSED';
      if (isPreCheckout) {
        preCheckout += 1;
        if (ageMs > 24 * 60 * 60 * 1000) stale24 += 1;
        if (ageMs > 72 * 60 * 60 * 1000) stale72 += 1;
      }
    });
    return { total: raw.length, stageCounts, preCheckout, stale24, stale72 };
  } catch (err) {
    return { total: 0, stageCounts: {}, preCheckout: 0, stale24: 0, stale72: 0, error: err.message };
  }
}

// 2026-08-09 addition — this join previously didn't exist anywhere despite
// both halves already being logged (2026-08-09 audit finding: "nudge A/B
// data is logged but never analyzed"). Deliberately ALL-TIME cumulative,
// unlike the windowed since-last-report deltas above: a cart-recovery
// conversion can lag its nudge by up to ~24-48h (cartNudgeSecondDelayHours),
// so a short reporting window would badly undercount attribution, and both
// source files are cheap to re-derive from scratch on every run.
//
// Attribution mirrors llmAgent.js's own recoveryNote logic exactly: a chat
// that got a 2nd (shipping) nudge after an unanswered 1st (price) nudge has
// the 2nd, more recent, more specific touch credited for any eventual
// conversion — not both. nudge_generic (sent when a session went idle with
// no recommendedProduct yet) is excluded — it has no A/B variant to compare.
function gatherNudgeAttributionStats() {
  let sessionsByChatId;
  try {
    sessionsByChatId = new Map(JSON.parse(fs.readFileSync(SESSIONS_STATE_PATH, 'utf-8')));
  } catch (err) {
    return { variants: {}, totalChatsNudged: 0, error: err.message };
  }

  if (!fs.existsSync(CHAT_HISTORY_LOG_PATH)) return { variants: {}, totalChatsNudged: 0 };

  const creditedVariantByChatId = new Map(); // chatId -> { first: variantId, second: variantId }
  const lines = fs.readFileSync(CHAT_HISTORY_LOG_PATH, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      continue; // a single malformed line must never abort the whole report
    }
    if (rec.dir !== 'OUT' || !rec.variantId) continue;
    const stageKey = rec.variantId.startsWith('nudge1_') ? 'first' : rec.variantId.startsWith('nudge2_') ? 'second' : null;
    if (!stageKey) continue;
    const existing = creditedVariantByChatId.get(rec.chatId) || {};
    existing[stageKey] = rec.variantId; // last one wins if a chat somehow got the same stage twice
    creditedVariantByChatId.set(rec.chatId, existing);
  }

  const variants = {};
  const bump = (variantId, key) => {
    if (!variants[variantId]) variants[variantId] = { sent: 0, converted: 0 };
    variants[variantId][key] += 1;
  };

  for (const [chatId, stages] of creditedVariantByChatId.entries()) {
    const creditedVariant = stages.second || stages.first;
    if (!creditedVariant) continue;
    bump(creditedVariant, 'sent');
    const session = sessionsByChatId.get(chatId);
    if (session && session.orderPlaced) {
      bump(creditedVariant, 'converted');
    }
  }

  return { variants, totalChatsNudged: creditedVariantByChatId.size };
}

function gatherGitLog(windowStart) {
  try {
    const output = execSync(`git log --since="${windowStart.toISOString()}" --oneline`, { cwd: REPO_ROOT, encoding: 'utf-8' });
    return output.split('\n').filter(Boolean);
  } catch (err) {
    return [];
  }
}

function gatherPm2Status() {
  try {
    const output = execSync('pm2 jlist', { encoding: 'utf-8' });
    const list = JSON.parse(output);
    const bot = list.find((p) => p.name === 'beauty-hub-bot');
    if (!bot) return null;
    return {
      status: bot.pm2_env.status,
      restarts: bot.pm2_env.restart_time,
      uptimeMs: Date.now() - bot.pm2_env.pm_uptime,
      memoryMb: Math.round((bot.monit && bot.monit.memory ? bot.monit.memory : 0) / 1024 / 1024),
    };
  } catch (err) {
    return null;
  }
}

const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'A short paragraph summarizing overall bot health and activity since the last report.' },
    actionItems: {
      type: 'array',
      description: 'Concrete, specific, independently-actionable fixes or improvements. Empty array if nothing genuinely needs action right now — do not invent busywork.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line, specific enough to identify the fix without the description.' },
          description: { type: 'string', description: 'What to do and why, concrete enough that a coding agent with no other context could implement it.' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['title', 'description', 'severity'],
      },
    },
  },
  required: ['summary', 'actionItems'],
});

// 2026-08-07: investigated a report action item claiming 68/109 sessions were
// "stuck at AWAIT_CATEGORY". Root cause: with AGENT_MODE=llm live for
// everyone (confirmed in .env), session.stage no longer means what it did
// under the old rules engine — llmAgent.js's applyValidatedOutput() maps
// EVERY session that hasn't reached a product recommendation, order
// collection, or close/handover onto STAGES.AWAIT_CATEGORY as a catch-all,
// purely so cartRecovery.js/chatLogger keep working unchanged (see the
// comment there). Confirmed on the live sessions_state.json snapshot: 0 of
// the 68 even have `category` set, and ~44% are brand-new conversations
// (<=2 turns), not stalled ones. Also confirmed it isn't Sheets-outage
// product starvation: productMatcher.js's refreshFromGoogleSheets() keeps the
// last successfully loaded catalog on any fetch failure rather than emptying
// it. So a high AWAIT_CATEGORY count is not evidence of a broken
// category-selection step by itself — the stale24/stale72 pre-checkout
// numbers already below are the meaningful staleness signal. This note steers
// the reporting LLM away from re-raising the same false lead.
const AWAIT_CATEGORY_STAGE_NOTE =
  ' Note: with AGENT_MODE=llm live, session.stage="AWAIT_CATEGORY" is llmAgent.js\'s catch-all bucket for "no product recommended yet" (includes brand-new conversations), not literal category-selection blocking — do not raise an action item about a broken category flow from this count alone; the stale24/stale72 figures are the actual staleness signal.';

// Shared between buildPrompt (LLM-facing) and formatEmailBody (human-facing)
// so the two never drift into disagreeing about the same numbers.
function formatNudgeAttributionForDisplay(nudgeAttribution) {
  const variantIds = Object.keys(nudgeAttribution.variants || {});
  if (variantIds.length === 0) return '(no cart-recovery nudges logged yet)';
  return variantIds
    .sort()
    .map((id) => {
      const { sent, converted } = nudgeAttribution.variants[id];
      const rate = sent > 0 ? `${((converted / sent) * 100).toFixed(0)}%` : 'n/a';
      return `${id}: ${converted}/${sent} converted (${rate})`;
    })
    .join('\n');
}

function buildPrompt(stats) {
  const stageNote = config.agentMode === 'llm' ? AWAIT_CATEGORY_STAGE_NOTE : '';
  return `You are producing a periodic health-check report for a production WhatsApp sales bot ("Sara" for Beauty Hub October, an Egyptian Arabic cosmetics store) — beauty-hub-october-bot, PM2-managed. This report is read by the store owner AND may become an actionable task for a separate coding agent, so keep actionItems concrete and specific, not vague advice.

Stats since the last report (${stats.windowStart} to now, system-generated aggregates only — no raw customer message content):

PM2 error log: ${stats.pm2Errors.count} error lines logged. Sample (deduplicate mentally, these are often repeats):
${stats.pm2Errors.sample.join('\n') || '(none)'}

Live session snapshot: ${stats.sessions.total} total sessions. Stage distribution: ${JSON.stringify(stats.sessions.stageCounts)}.${stageNote} Of ${stats.sessions.preCheckout} pre-checkout sessions, ${stats.sessions.stale24} are stale >24h and ${stats.sessions.stale72} are stale >72h.

Cart-recovery nudge A/B attribution (ALL-TIME cumulative, not scoped to this reporting window — see gatherNudgeAttributionStats' comment for why): ${stats.nudgeAttribution.totalChatsNudged || 0} customers ever nudged. Conversion by variant (converted/sent):
${formatNudgeAttributionForDisplay(stats.nudgeAttribution)}
If one variant within the same nudge stage (nudge1_price_a vs. nudge1_price_b, or nudge2_shipping_a vs. nudge2_shipping_b) has a meaningfully lower conversion rate on a decent sample size, that's worth a concrete action item (e.g. retire the weaker wording). Do not raise this if sample sizes are too small to mean anything (single digits per variant).

Git commits since last report: ${stats.gitLog.length ? stats.gitLog.join('\n') : '(none)'}

PM2 process status: ${stats.pm2Status ? JSON.stringify(stats.pm2Status) : 'unavailable'}

Produce a short summary and a prioritized action-item list per the schema. Focus on things that genuinely need attention — a quiet, healthy period should produce zero or very few items, not padding. Do not reference or ask to see any customer conversation content — you don't have it and shouldn't need it for this kind of structural/operational report.`;
}

function runAnalysis(prompt) {
  const output = execFileSync(
    'claude',
    ['-p', prompt, '--allowedTools', '', '--output-format', 'json', '--json-schema', JSON_SCHEMA],
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 120000 }
  );
  const parsed = JSON.parse(output);
  if (!parsed.structured_output) {
    throw new Error(`No structured_output in claude response: ${output.slice(0, 500)}`);
  }
  return parsed.structured_output;
}

function formatEmailBody(stats, analysis) {
  return [
    `BEAUTY HUB OCTOBER — SCHEDULED HEALTH CHECK`,
    `Window: ${stats.windowStart} → ${new Date().toISOString()}`,
    ``,
    `SUMMARY`,
    analysis.summary,
    ``,
    `ACTION ITEMS (${analysis.actionItems.length})`,
    ...analysis.actionItems.map((item, i) => `${i + 1}. [${item.severity}] ${item.title}\n   ${item.description}`),
    ``,
    `RAW STATS`,
    `PM2 errors: ${stats.pm2Errors.count}`,
    `Sessions: ${stats.sessions.total} total, ${stats.sessions.preCheckout} pre-checkout (${stats.sessions.stale24} stale >24h, ${stats.sessions.stale72} stale >72h)`,
    `Stage distribution: ${JSON.stringify(stats.sessions.stageCounts)}`,
    `Cart-recovery nudge attribution (all-time, ${stats.nudgeAttribution.totalChatsNudged || 0} customers nudged):`,
    formatNudgeAttributionForDisplay(stats.nudgeAttribution),
    `Git commits: ${stats.gitLog.length}`,
    stats.gitLog.length ? stats.gitLog.join('\n') : '',
    `PM2 status: ${stats.pm2Status ? JSON.stringify(stats.pm2Status) : 'unavailable'}`,
  ].join('\n');
}

async function submitToBot(analysis) {
  const res = await fetch(`http://localhost:${config.port}/admin/submit-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Send-Token': config.adminSendToken },
    body: JSON.stringify(analysis),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/admin/submit-report returned ${res.status}: ${text}`);
  }
  return res.json();
}

async function main() {
  const windowStart = getWindowStart();
  const stats = {
    windowStart: windowStart.toISOString(),
    pm2Errors: gatherPm2ErrorStats(windowStart),
    sessions: gatherSessionStats(),
    nudgeAttribution: gatherNudgeAttributionStats(),
    gitLog: gatherGitLog(windowStart),
    pm2Status: gatherPm2Status(),
  };

  console.log(`[scheduledReport] Gathered stats since ${stats.windowStart}. Running analysis...`);
  const analysis = runAnalysis(buildPrompt(stats));
  console.log(`[scheduledReport] Analysis complete: ${analysis.actionItems.length} action item(s).`);

  await emailAlert.sendAlert('scheduled_report', {
    subject: `Beauty Hub October — scheduled health check (${analysis.actionItems.length} item(s))`,
    text: formatEmailBody(stats, analysis),
  });
  console.log('[scheduledReport] Email sent.');

  const result = await submitToBot(analysis);
  console.log(`[scheduledReport] Submitted to bot. ${result.items.length} item(s) now pending confirmation.`);
}

main().catch((err) => {
  console.error('[scheduledReport] FAILED:', err);
  process.exitCode = 1;
});
