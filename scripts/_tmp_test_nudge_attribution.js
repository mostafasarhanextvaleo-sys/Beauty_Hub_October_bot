// Regression check (not committed) for the 2026-08-09 P1 fix: cart-recovery
// nudge variantIds were logged but never joined against order outcomes — the
// audit flagged "reporting only, no code change" and scripts/scheduledReport.js
// now does that join in gatherNudgeAttributionStats(). That function can't be
// required directly here: scheduledReport.js runs its whole pipeline
// (real email send, a real headless `claude -p` call, a live POST to the
// running bot's /admin/submit-report) unconditionally at module load, with no
// require.main guard. So this is a deliberate, manually-kept-in-sync COPY of
// just that one pure function, run standalone against a synthetic
// chat_history.log + sessions_state.json fixture (never the real production
// files) to verify the attribution logic itself: last-touch crediting (2nd
// nudge wins over 1st if both were sent), nudge_generic exclusion, and the
// converted/sent counts. See the bottom of this file for a SEPARATE run
// against the real production data (read-only, no writes) to report the
// actual current numbers.
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

function gatherNudgeAttributionStats(sessionsPath, chatHistoryPath) {
  let sessionsByChatId;
  try {
    sessionsByChatId = new Map(JSON.parse(fs.readFileSync(sessionsPath, 'utf-8')));
  } catch (err) {
    return { variants: {}, totalChatsNudged: 0, error: err.message };
  }
  if (!fs.existsSync(chatHistoryPath)) return { variants: {}, totalChatsNudged: 0 };

  const creditedVariantByChatId = new Map();
  const lines = fs.readFileSync(chatHistoryPath, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (err) {
      continue;
    }
    if (rec.dir !== 'OUT' || !rec.variantId) continue;
    const stageKey = rec.variantId.startsWith('nudge1_') ? 'first' : rec.variantId.startsWith('nudge2_') ? 'second' : null;
    if (!stageKey) continue;
    const existing = creditedVariantByChatId.get(rec.chatId) || {};
    existing[stageKey] = rec.variantId;
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
    if (session && session.orderPlaced) bump(creditedVariant, 'converted');
  }
  return { variants, totalChatsNudged: creditedVariantByChatId.size };
}

// --- Part 1: correctness against a synthetic fixture ---
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-attr-test-'));
  const sessionsPath = path.join(tmpDir, 'sessions_state.json');
  const chatHistoryPath = path.join(tmpDir, 'chat_history.log');

  // chatA: only nudge1_price_a, converted.
  // chatB: nudge1_price_b then nudge2_shipping_a (2nd should win the credit), converted.
  // chatC: nudge1_price_a, NOT converted.
  // chatD: nudge_generic only (no product yet) — must be excluded entirely.
  fs.writeFileSync(
    chatHistoryPath,
    [
      { dir: 'OUT', chatId: 'chatA@lid', variantId: 'nudge1_price_a' },
      { dir: 'OUT', chatId: 'chatB@lid', variantId: 'nudge1_price_b' },
      { dir: 'OUT', chatId: 'chatB@lid', variantId: 'nudge2_shipping_a' },
      { dir: 'OUT', chatId: 'chatC@lid', variantId: 'nudge1_price_a' },
      { dir: 'OUT', chatId: 'chatD@lid', variantId: 'nudge_generic' },
      { dir: 'IN', chatId: 'chatA@lid', variantId: null },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );
  fs.writeFileSync(
    sessionsPath,
    JSON.stringify([
      ['chatA@lid', { orderPlaced: true }],
      ['chatB@lid', { orderPlaced: true }],
      ['chatC@lid', { orderPlaced: false }],
      ['chatD@lid', { orderPlaced: true }],
    ])
  );

  const result = gatherNudgeAttributionStats(sessionsPath, chatHistoryPath);
  assert.strictEqual(result.totalChatsNudged, 3, 'expected chatD (generic-only) to be excluded, leaving 3 attributable chats');
  assert.deepStrictEqual(result.variants['nudge1_price_a'], { sent: 2, converted: 1 }, 'expected chatA (converted) and chatC (not converted) both credited to nudge1_price_a');
  assert.strictEqual(result.variants['nudge1_price_b'], undefined, 'expected chatB NOT credited to its 1st-stage variant');
  assert.deepStrictEqual(result.variants['nudge2_shipping_a'], { sent: 1, converted: 1 }, 'expected chatB credited to its 2nd-stage variant instead (last-touch attribution)');
  assert.strictEqual(result.variants['nudge_generic'], undefined, 'expected nudge_generic to never appear in variant stats');
  console.log('PASS: last-touch attribution, generic-nudge exclusion, and converted/sent counts are all correct.');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// --- Part 2: run against the REAL production data (read-only) to report actual numbers ---
{
  const REPO_ROOT = path.join(__dirname, '..');
  const result = gatherNudgeAttributionStats(
    path.join(REPO_ROOT, 'sessions_state.json'),
    path.join(REPO_ROOT, 'chat_history.log')
  );
  console.log(`\n=== REAL DATA: ${result.totalChatsNudged} customers ever nudged ===`);
  for (const [variantId, { sent, converted }] of Object.entries(result.variants).sort()) {
    const rate = sent > 0 ? `${((converted / sent) * 100).toFixed(0)}%` : 'n/a';
    console.log(`  ${variantId}: ${converted}/${sent} converted (${rate})`);
  }
}

console.log('\nALL NUDGE ATTRIBUTION TESTS PASSED');
process.exit(0);
