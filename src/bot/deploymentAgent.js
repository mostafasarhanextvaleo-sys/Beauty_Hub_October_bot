// Interactive WhatsApp health-check -> confirm -> deploy workflow (2026-08-06).
// State machine per item: awaiting_confirm -> drafting -> awaiting_deploy ->
// deploying -> restarting -> deployed (or *_failed at any step). Exactly one
// item may be mid-flight (drafting/awaiting_deploy/deploying/restarting) at
// a time, enforced in handleConfirm below.
//
// Persistence follows conversationMemory.js's ATOMIC tmp-file+rename pattern
// (not delivery_followup_state.json's older plain writeFileSync) — every
// mutation goes through withState() below, which serializes via
// chatLock.js's runExclusive under one fixed lock key. This module is the
// SOLE writer of pending_confirmations.json: the standalone cron script
// (scripts/scheduledReport.js) never touches this file directly — it POSTs
// to /admin/submit-report so the merge happens here, under the same lock,
// avoiding a lost-update race between two separate OS processes.
const fs = require('fs');
const path = require('path');
const { spawn, execSync, execFileSync } = require('child_process');
const logger = require('../utils/logger');
const { runExclusive } = require('../utils/chatLock');
const config = require('../config');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_PATH = path.join(REPO_ROOT, 'pending_confirmations.json');
const DRAFT_RESULT_PATH = path.join(REPO_ROOT, '.deploy_draft_result.json');
const LOCK_KEY = '__pending_confirmations_persist__';
const DRAFT_TIMEOUT_MS = 15 * 60 * 1000;
const MID_FLIGHT_STATUSES = ['drafting', 'awaiting_deploy', 'deploying', 'restarting'];

// Never trust the draft agent's self-reported filesChanged alone — this is
// re-checked independently against the real working tree at deploy time,
// regardless of what the (file-editing, Bash-enabled) draft subprocess
// claims it touched.
const FORBIDDEN_FILE_PATTERNS = [
  /^\.env$/,
  /^credentials\.json$/,
  /_state\.json$/,
  /^sessions_state\.json$/,
  /^\.wwebjs_auth\//,
  /^\.wwebjs_cache\//,
  /^node_modules\//,
];

let state = { nextId: 1, items: [], lastReportAt: null };

function loadState() {
  try {
    if (!fs.existsSync(STATE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    if (raw && Array.isArray(raw.items)) state = raw;
  } catch (err) {
    logger.error('Failed to load pending_confirmations.json. Starting fresh.', err);
  }
}
loadState();

async function persistStateNow() {
  const tmpPath = `${STATE_PATH}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(state, null, 2));
    await fs.promises.rename(tmpPath, STATE_PATH);
  } catch (err) {
    logger.error('Failed to persist pending_confirmations.json.', err);
  }
}

// Every read-modify-write of `state` goes through here — single lock key,
// so the cron script's report merge and a live Confirm/Deploy action can
// never interleave into a lost update.
function withState(mutator) {
  return runExclusive(LOCK_KEY, async () => {
    await mutator(state);
    await persistStateNow();
  });
}

function isMidFlight(item) {
  return MID_FLIGHT_STATUSES.includes(item.status);
}

// Lazy require — whatsapp/client.js will require this module too (to route
// "Confirm N"/"Deploy N" messages), so requiring it at top-level here would
// be a circular require. Safe to resolve at call time instead.
function notifyAdmin(text) {
  const whatsappClient = require('../whatsapp/client');
  const jid = config.adminWhatsappNumber.includes('@') ? config.adminWhatsappNumber : `${config.adminWhatsappNumber}@c.us`;
  return whatsappClient.sendMessageToChatId(jid, text).catch((err) => {
    logger.error('deploymentAgent failed to notify admin over WhatsApp.', err);
  });
}

function matchConfirm(text) {
  const t = (text || '').trim();
  let m = t.match(/^confirm\s*#?\s*(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/^موافق\s*على\s*#?\s*(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function matchDeploy(text) {
  const t = (text || '').trim();
  let m = t.match(/^deploy\s*#?\s*(\d+)$/i);
  if (m) return parseInt(m[1], 10);
  m = t.match(/^نفذ\s*#?\s*(\d+)$/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Sole entry point client.js calls. Returns a reply string to send
// immediately, or null if this message isn't a Confirm/Deploy trigger at
// all — caller falls through to normal admin/customer handling in that case.
async function handleDeploymentMessage(text) {
  const confirmId = matchConfirm(text);
  if (confirmId !== null) return handleConfirm(confirmId);
  const deployId = matchDeploy(text);
  if (deployId !== null) return handleDeploy(deployId);
  return null;
}

function buildDraftPrompt(item) {
  return `You are implementing a single fix in the production repo at ${REPO_ROOT} — a live WhatsApp sales bot (PM2-managed) currently serving real customers. Be careful and minimal; this is not a greenfield task.

Fix to implement:
Title: ${item.title}
Description: ${item.description}

Follow this codebase's existing conventions: reuse existing helpers rather than inventing new ones, keep the change minimal and scoped to exactly this fix, and verify your work (run any relevant existing scripts/_tmp_test_*.js, or write a small throwaway isolated check the same way — never against real production data/sessions).

Do NOT modify .env, credentials.json, or any *_state.json file. Do NOT attempt to run git add, git commit, git push, or any pm2 command — a separate deploy step handles that; just leave your changes uncommitted in the working tree.

When finished (or if you determine this fix isn't safe to implement as described, or needs clarification), write your result as JSON to ${DRAFT_RESULT_PATH} — exactly this shape, nothing else in the file:
{"status": "ready" or "failed", "summary": "one paragraph: what you changed and why", "filesChanged": ["relative/path/from/repo/root.js"], "testOutput": "relevant verification output", "risks": "anything the deployer should know before shipping this, or empty string"}`;
}

function runDraftAgent(item) {
  return new Promise((resolve) => {
    try {
      if (fs.existsSync(DRAFT_RESULT_PATH)) fs.unlinkSync(DRAFT_RESULT_PATH);
    } catch (err) {
      logger.error('Failed to clear stale draft result file before starting a new draft.', err);
    }

    const child = spawn(
      'claude',
      [
        '-p',
        buildDraftPrompt(item),
        '--allowedTools',
        'Read Edit Grep Glob Bash(node *) Bash(git status*) Bash(git diff*)',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'json',
      ],
      { cwd: REPO_ROOT }
    );

    withState((s) => {
      const it = s.items.find((i) => i.id === item.id);
      if (it) it.draftPid = child.pid;
    }).catch(() => {});

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.error(`Draft agent for item ${item.id} exceeded ${DRAFT_TIMEOUT_MS}ms — killing.`);
      child.kill('SIGKILL');
      handleDraftComplete(item.id, null).finally(resolve);
    }, DRAFT_TIMEOUT_MS);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.error(`Failed to spawn draft agent for item ${item.id}.`, err);
      handleDraftComplete(item.id, null).finally(resolve);
    });

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handleDraftComplete(item.id, null).finally(resolve);
    });
  });
}

// code param kept for future use (currently unused — result is read from
// DRAFT_RESULT_PATH regardless of exit code, since a non-zero exit with a
// valid result file still counts as a real answer).
async function handleDraftComplete(itemId) {
  let result = null;
  try {
    if (fs.existsSync(DRAFT_RESULT_PATH)) {
      result = JSON.parse(fs.readFileSync(DRAFT_RESULT_PATH, 'utf-8'));
    }
  } catch (err) {
    logger.error(`Failed to parse draft result for item ${itemId}.`, err);
  }

  if (!result || result.status !== 'ready') {
    await withState((s) => {
      const it = s.items.find((i) => i.id === itemId);
      if (it) {
        it.status = 'draft_failed';
        it.draftSummary = (result && result.summary) || 'التنفيذ اتقطع أو فشل من غير نتيجة واضحة — راجع لوج البوت.';
      }
    });
    await notifyAdmin(`❌ فشل تنفيذ البند رقم ${itemId}.\n${(result && result.summary) || 'مفيش نتيجة واضحة — راجع اللوج.'}`);
    return;
  }

  await withState((s) => {
    const it = s.items.find((i) => i.id === itemId);
    if (it) {
      it.status = 'awaiting_deploy';
      it.filesChanged = Array.isArray(result.filesChanged) ? result.filesChanged : [];
      it.draftSummary = result.summary || '';
    }
  });
  const riskNote = result.risks ? `\n⚠️ ${result.risks}` : '';
  await notifyAdmin(
    `✅ البند رقم ${itemId} جاهز:\n${result.summary}${riskNote}\n\nالملفات: ${(result.filesChanged || []).join(', ') || 'لا يوجد'}\n\nرد بـ"Deploy ${itemId}" عشان ترفع التغيير، أو سيبه لو عايز تراجع.`
  );
}

async function handleConfirm(id) {
  const inFlight = state.items.find(isMidFlight);
  if (inFlight) {
    return `في تنفيذ شغال دلوقتي على البند رقم ${inFlight.id} (${inFlight.status}) — استني ده يخلص قبل ما تأكد بند تاني.`;
  }
  const item = state.items.find((i) => i.id === id);
  if (!item) return `مفيش بند رقم ${id} حاليًا.`;
  if (item.status !== 'awaiting_confirm') {
    return `البند رقم ${id} حالته دلوقتي "${item.status}" — مش جاهز للتأكيد تاني.`;
  }

  await withState((s) => {
    const it = s.items.find((i) => i.id === id);
    it.status = 'drafting';
    it.draftStartedAt = new Date().toISOString();
  });

  // Fire-and-forget — the ack below is returned to the caller immediately;
  // the draft itself reports back over WhatsApp on its own when it finishes.
  runDraftAgent(item).catch((err) => logger.error(`Unhandled error running draft agent for item ${id}.`, err));

  return `تمام، هبدأ في تنفيذ البند رقم ${id}: "${item.title}" دلوقتي. هبعتلك تحديث لما يخلص (ممكن ياخد لحد ١٥ دقيقة).`;
}

function checkForForbiddenFiles() {
  const output = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf-8' });
  const changedFiles = output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  const forbidden = changedFiles.filter((f) => FORBIDDEN_FILE_PATTERNS.some((re) => re.test(f)));
  return { safe: forbidden.length === 0, forbidden, changedFiles };
}

async function handleDeploy(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return `مفيش بند رقم ${id} حاليًا.`;
  if (item.status !== 'awaiting_deploy') {
    return `البند رقم ${id} حالته دلوقتي "${item.status}" — لازم يكون "جاهز للرفع" الأول (رد بـ"Confirm ${id}" لو لسه محتاج تبدأ).`;
  }

  // Independent secret-file guard — checked against the real working tree,
  // never trusting the draft's self-reported filesChanged alone.
  const guard = checkForForbiddenFiles();
  if (!guard.safe) {
    await withState((s) => {
      const it = s.items.find((i) => i.id === id);
      if (it) it.status = 'deploy_failed';
    });
    return `⚠️ الرفع اتوقف للبند رقم ${id} — في ملفات حساسة اتغيرت (${guard.forbidden.join(', ')}). لازم تتراجع عنها يدويًا قبل أي رفع.`;
  }

  const filesToCommit = item.filesChanged.filter((f) => guard.changedFiles.includes(f));
  if (filesToCommit.length === 0) {
    await withState((s) => {
      const it = s.items.find((i) => i.id === id);
      if (it) it.status = 'deploy_failed';
    });
    return `مفيش حاجة اتغيرت فعليًا للبند رقم ${id} — الرفع اتوقف قبل أي تغيير على السيرفر.`;
  }

  await withState((s) => {
    const it = s.items.find((i) => i.id === id);
    if (it) it.status = 'deploying';
  });

  try {
    // execFileSync (argv array, no shell) rather than execSync's shell string
    // — item.title/item.draftSummary are LLM-generated prose that routinely
    // contains markdown backticks (e.g. "the `category` field"). The old
    // execSync(..., {shell: '/bin/bash'}) only JSON-escaped these strings,
    // which quotes for JSON, not for bash: bash still expands `...`/$(...)/
    // $VAR inside a double-quoted argument. Confirmed live in the pm2 error
    // log — a draft summary's backtick-quoted "category" was executed as a
    // command substitution, logging "category: command not found" (harmless
    // by luck, since no such binary exists, but the same shape with a real
    // command in a future draft summary would execute it against this
    // production repo). execFileSync never invokes a shell to parse the
    // argument at all, so this class of injection isn't just escaped, it's
    // structurally impossible.
    execFileSync('git', ['add', '--', ...filesToCommit], { cwd: REPO_ROOT });
    const commitMessage = `Deploy item #${id}: ${item.title}\n\n${item.draftSummary}\n\nvia WhatsApp Confirm/Deploy workflow`;
    execFileSync('git', ['commit', '-m', commitMessage], { cwd: REPO_ROOT });
  } catch (err) {
    logger.error(`Deploy commit failed for item ${id}.`, err);
    await withState((s) => {
      const it = s.items.find((i) => i.id === id);
      if (it) it.status = 'deploy_failed';
    });
    return `فشل الكوميت للبند رقم ${id}: ${err.message}`;
  }

  await withState((s) => {
    const it = s.items.find((i) => i.id === id);
    if (it) it.status = 'restarting';
  });

  // This ack reply is best-effort: pm2 restart is about to kill this very
  // process. It is NOT the authoritative "done" confirmation — that comes
  // from reconcileOnBoot() below, in the NEW process, once it's actually
  // back up and healthy. Scheduled via setImmediate so the caller's own
  // client.sendMessage(reply) call gets a chance to start before this
  // synchronous, briefly-blocking restart fires.
  //
  // 2026-08-08: this used to be a synchronous execSync('pm2 restart ...')
  // whose own child process — invoking `pm2 restart` on the very app this
  // process IS — regularly got killed mid-command by the restart it just
  // triggered, before the CLI could exit 0. execSync then threw and logged
  // "pm2 restart failed for item N" as an ERROR even though the restart
  // itself had already succeeded (confirmed against pm2.log/error.log: every
  // one of these "failures" is immediately followed by a real
  // "Received SIGINT. Shutting down gracefully" from the new boot). That
  // false-alarm pattern is exactly what fed scheduledReport.js's "crash
  // loop" framing in the diagnostic report — item #5 in
  // pending_confirmations.json already found there was no real crash loop,
  // just this log noise plus normal deploy-triggered restarts. Detached +
  // unref'd spawn hands the restart to the OS/pm2 daemon independently of
  // this process's lifetime, so it can't be killed mid-flight by the very
  // restart it's requesting, and there's nothing meaningful left to catch —
  // any real failure to restart is what reconcileOnBoot()'s health check on
  // the next boot is for.
  setImmediate(() => {
    try {
      spawn('pm2', ['restart', 'beauty-hub-bot'], { cwd: REPO_ROOT, detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      logger.error(`Failed to spawn pm2 restart for item ${id}.`, err);
    }
  });

  return `تمام، البند رقم ${id} اتعمله كوميت وهعيد تشغيل البوت دلوقتي. هبعتلك تأكيد نهائي لما يرجع تمام.`;
}

// Called from index.js's main() once WhatsApp is confirmed connected on a
// fresh boot. healthCheckFn should return a boolean (or Promise<boolean>).
async function reconcileOnBoot(healthCheckFn) {
  const restarting = state.items.find((i) => i.status === 'restarting');
  if (restarting) {
    let healthy = false;
    try {
      healthy = await healthCheckFn();
    } catch (err) {
      logger.error('Post-deploy health check threw.', err);
    }
    await withState((s) => {
      const it = s.items.find((i) => i.id === restarting.id);
      if (it) it.status = healthy ? 'deployed' : 'deploy_failed';
    });
    await notifyAdmin(
      healthy
        ? `✅ تم! البند رقم ${restarting.id} ("${restarting.title}") اترفع، والبوت شغال تمام.`
        : `⚠️ البند رقم ${restarting.id} اترفع لكن فحص الصحة بعد إعادة التشغيل مش تمام — يستحق مراجعة يدوية دلوقتي.`
    );
  }

  // A "drafting" item surviving to a fresh boot means the PREVIOUS process
  // instance died mid-draft for an unrelated reason (any uncaughtException
  // triggers process.exit(1) elsewhere in this codebase) — the in-memory
  // 15-min timeout for it died with that process, so nothing will ever
  // resolve it on its own. No attempt to re-attach to the orphaned child;
  // just surface it clearly so the owner can re-confirm if still wanted.
  const orphaned = state.items.filter((i) => i.status === 'drafting');
  for (const item of orphaned) {
    // eslint-disable-next-line no-await-in-loop
    await withState((s) => {
      const it = s.items.find((i) => i.id === item.id);
      if (it) {
        it.status = 'draft_failed';
        it.draftSummary = 'اترفعله إعادة تشغيل غير متعلقة بيه أثناء التنفيذ — التنفيذ اتقطع.';
      }
    });
    // eslint-disable-next-line no-await-in-loop
    await notifyAdmin(`⚠️ البند رقم ${item.id} كان بينفذ لما البوت اترستارت لسبب مختلف تمامًا — التنفيذ اتقطع. رد بـ"Confirm ${item.id}" لو لسه عايزه.`);
  }
}

// Called by index.js's /admin/submit-report handler with the cron script's
// {summary, actionItems}. Sole place new items enter the state file, and
// sole place the WhatsApp summary for a new report is sent — both under the
// same lock, so this can never interleave with a live Confirm/Deploy action.
async function submitReport({ summary, actionItems }) {
  const result = await runExclusive(LOCK_KEY, async () => {
    // Fresh report supersedes any previously-unactioned awaiting_confirm
    // items (they were this cycle's suggestions, now stale) — but anything
    // already mid-flight or resolved is preserved as history/in-progress.
    const preserved = state.items.filter((item) => item.status !== 'awaiting_confirm');
    const newItems = (Array.isArray(actionItems) ? actionItems : []).map((raw) => {
      const id = state.nextId++;
      return {
        id,
        title: String(raw.title || '').slice(0, 300),
        description: String(raw.description || '').slice(0, 2000),
        severity: raw.severity || 'medium',
        status: 'awaiting_confirm',
        createdAt: new Date().toISOString(),
        draftStartedAt: null,
        draftPid: null,
        filesChanged: [],
        draftSummary: '',
      };
    });
    state.items = [...preserved, ...newItems];
    state.lastReportAt = new Date().toISOString();
    await persistStateNow();
    return { newItems, midFlight: preserved.filter(isMidFlight) };
  });

  const lines = [`📋 تقرير صحة البوت — ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}`, '', String(summary || '').slice(0, 1500)];
  lines.push('');
  if (result.newItems.length === 0) {
    lines.push('مفيش بنود جديدة محتاجة أكشن دلوقتي. ✅');
  } else {
    lines.push('البنود المقترحة:');
    result.newItems.forEach((it) => lines.push(`${it.id}. [${it.severity}] ${it.title}`));
    lines.push('', 'رد بـ"Confirm N" عشان أبدأ في تنفيذ بند معين.');
  }
  if (result.midFlight.length > 0) {
    lines.push('', `(فيه بند لسه شغال من قبل التقرير ده: رقم ${result.midFlight.map((i) => i.id).join(', ')} — حالته ${result.midFlight[0].status})`);
  }
  await notifyAdmin(lines.join('\n'));
  return result.newItems;
}

module.exports = {
  handleDeploymentMessage,
  submitReport,
  reconcileOnBoot,
};
