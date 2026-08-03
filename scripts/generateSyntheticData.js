// Generates synthetic training examples for the local-model fine-tune by
// driving the REAL production pipeline (productSearch candidate matching,
// buildSystemPrompt, sanitizeModelOutput/validateModelOutput) with scripted
// (non-LLM) customer messages, and recording the teacher model's validated
// structured reply as the training label.
//
// Usage: node scripts/generateSyntheticData.js [--limit N] [--concurrency N]
//   --limit N        only process the first N conversation plans (dry run)
//   --concurrency N  max conversations in flight at once (default 8)

const fs = require('fs');
const path = require('path');

const { buildConversationPlans } = require('./lib/syntheticTemplates');
const googleSheets = require('../src/services/googleSheets');
const productMatcher = require('../src/bot/productMatcher');
const { buildSystemPrompt, RESPONSE_SCHEMA } = require('../src/bot/llmSystemPrompt');
const openaiService = require('../src/services/openaiService');
const geminiService = require('../src/services/geminiService');
const {
  sanitizeModelOutput,
  validateModelOutput,
  pushHistory,
  selectCandidatesForTurn,
} = require('../src/bot/llmAgent');

const CATALOG_PATH = path.join(__dirname, '..', 'training-data', 'catalog.jsonl');
const OUT_PATH = path.join(__dirname, '..', 'training-data', 'synthetic_conversations.jsonl');
const OPENAI_WEIGHT = 0.85;
const MAX_RETRIES_PER_TURN = 2;

function parseArgs() {
  const args = { limit: Infinity, concurrency: 8, category: null };
  process.argv.slice(2).forEach((arg, i, arr) => {
    if (arg === '--limit') args.limit = parseInt(arr[i + 1], 10);
    if (arg === '--concurrency') args.concurrency = parseInt(arr[i + 1], 10);
    if (arg === '--category') args.category = arr[i + 1];
  });
  return args;
}

function loadCatalog() {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// Approximate only (Arabic/JSON-heavy content doesn't map cleanly to a fixed
// chars-per-token ratio) — good enough for a cost ballpark, not for billing.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 3.5);
}

// Serializes all appends so concurrent conversations never interleave
// partial JSON lines into the output file.
let writeQueue = Promise.resolve();
function appendResultLine(obj) {
  const line = JSON.stringify(obj) + '\n';
  writeQueue = writeQueue.then(
    () => fs.promises.appendFile(OUT_PATH, line),
    () => fs.promises.appendFile(OUT_PATH, line) // still write even if a prior write failed
  );
  return writeQueue;
}

function pickTeacher() {
  return Math.random() < OPENAI_WEIGHT ? 'openai' : 'gemini';
}

async function callTeacher(teacher, args) {
  if (teacher === 'openai') return openaiService.generateStructuredReply(args);
  return geminiService.generateStructuredReply(args);
}

const stats = {
  conversationsStarted: 0,
  conversationsCompleted: 0,
  examplesWritten: 0,
  turnsFailed: 0,
  byTeacher: { openai: 0, gemini: 0 },
  byCategory: {},
  inputTokens: 0,
  outputTokens: 0,
};

async function runConversation(plan) {
  stats.conversationsStarted += 1;
  const teacher = pickTeacher();
  let history = [];
  let shownProductIds = [];
  let recommendedProduct = null;

  for (const turnText of plan.turns) {
    const candidates = await selectCandidatesForTurn(turnText, { excludeIds: shownProductIds, recommendedProduct });
    const systemInstruction = buildSystemPrompt(candidates);
    const contents = [...history, { role: 'user', content: turnText }];
    const callArgs = { systemInstruction, contents, responseSchema: RESPONSE_SCHEMA };

    let validated = null;
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_TURN; attempt++) {
      const raw = await callTeacher(teacher, callArgs);
      if (raw) {
        validated = validateModelOutput(sanitizeModelOutput(raw), candidates);
        if (validated) break;
      }
    }

    stats.inputTokens += estimateTokens(systemInstruction) + estimateTokens(contents.map((c) => c.content).join(' '));

    if (!validated) {
      stats.turnsFailed += 1;
      break; // don't continue a broken conversation with no assistant turn to build on
    }

    stats.outputTokens += estimateTokens(JSON.stringify(validated));
    stats.examplesWritten += 1;
    stats.byTeacher[teacher] += 1;
    stats.byCategory[plan.category] = (stats.byCategory[plan.category] || 0) + 1;

    // `contents` is already the canonical {role, content} shape (see
    // llmAgent.js/openaiService.js) — this is exactly the OpenAI fine-tuning
    // messages format already, no conversion needed.
    const messages = [
      { role: 'system', content: systemInstruction },
      ...contents,
      { role: 'assistant', content: JSON.stringify(validated) },
    ];
    await appendResultLine({
      messages,
      meta: { providerUsed: teacher, category: plan.category, synthetic: true, ts: new Date().toISOString() },
    });

    const mentionedIds = Array.isArray(validated.mentioned_product_ids) ? validated.mentioned_product_ids : [];
    if (mentionedIds.length > 0) {
      const primary = candidates.find((p) => p.id === mentionedIds[0]);
      if (primary) recommendedProduct = primary;
    }
    shownProductIds = [...new Set([...shownProductIds, ...mentionedIds])];
    history = pushHistory(history, 'user', turnText);
    history = pushHistory(history, 'assistant', validated.reply_text);
  }

  stats.conversationsCompleted += 1;
}

async function runPool(plans, concurrency) {
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < plans.length) {
      const plan = plans[next];
      next += 1;
      await runConversation(plan);
      if (stats.conversationsCompleted % 25 === 0) {
        process.stdout.write(
          `\rprogress: ${stats.conversationsCompleted}/${plans.length} conversations, ${stats.examplesWritten} examples written, ${stats.turnsFailed} turns failed   `
        );
      }
    }
  });
  await Promise.all(workers);
}

async function main() {
  const { limit, concurrency, category } = parseArgs();

  // productSearch reads from productMatcher's in-memory list, which defaults
  // to the stale local products.json (no prices) at require-time — refresh it
  // from the same live Google Sheets source the real bot uses, or every
  // generated example will show "price unavailable" regardless of what
  // catalog.jsonl (used only for picking which products to ask about) says.
  await googleSheets.init();
  const refreshed = await productMatcher.refreshFromGoogleSheets();
  if (!refreshed) {
    console.error('Could not refresh product data from Google Sheets — aborting to avoid generating data against stale/priceless local products.json.');
    process.exit(1);
  }

  const catalog = loadCatalog();
  let plans = buildConversationPlans(catalog);
  if (category) plans = plans.filter((p) => p.category === category);
  if (Number.isFinite(limit)) plans = plans.slice(0, limit);

  console.log(`Loaded ${catalog.length} catalog products. Running ${plans.length} conversation plans at concurrency ${concurrency}.`);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const startedAt = Date.now();
  await runPool(plans, concurrency);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  const inputCostOpenai = (stats.inputTokens * (stats.byTeacher.openai / (stats.byTeacher.openai + stats.byTeacher.gemini || 1)) / 1e6) * 0.15;
  const outputCostOpenai = (stats.outputTokens * (stats.byTeacher.openai / (stats.byTeacher.openai + stats.byTeacher.gemini || 1)) / 1e6) * 0.6;
  const inputCostGemini = (stats.inputTokens * (stats.byTeacher.gemini / (stats.byTeacher.openai + stats.byTeacher.gemini || 1)) / 1e6) * 1.5;
  const outputCostGemini = (stats.outputTokens * (stats.byTeacher.gemini / (stats.byTeacher.openai + stats.byTeacher.gemini || 1)) / 1e6) * 9;
  const approxCost = inputCostOpenai + outputCostOpenai + inputCostGemini + outputCostGemini;

  console.log('\n\n=== Synthetic data generation summary ===');
  console.log(`Elapsed: ${elapsedSec}s`);
  console.log(`Conversations: ${stats.conversationsCompleted}/${plans.length}`);
  console.log(`Examples written: ${stats.examplesWritten}`);
  console.log(`Turns failed (validation exhausted retries): ${stats.turnsFailed}`);
  console.log(`By teacher: openai=${stats.byTeacher.openai} gemini=${stats.byTeacher.gemini}`);
  console.log(`By category:`, JSON.stringify(stats.byCategory, null, 2));
  console.log(`Approx tokens: input=${stats.inputTokens} output=${stats.outputTokens}`);
  console.log(`Approx cost (rough estimate, not exact billing): $${approxCost.toFixed(2)}`);
  console.log(`Output: ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('Generation failed:', err);
  process.exit(1);
});
