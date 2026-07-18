/**
 * One-time (re-runnable/idempotent) AI tagging pass for the Products Google
 * Sheet: fills in Skin/Hair Type (column G) for products missing it, and adds
 * a new Routine Step column (H is In Stock, so this goes in I) classifying
 * skincare products as Cleanser/Toner/Serum/Moisturizer/Sunscreen/Mask/Other
 * — using gemma2 (general-purpose local model), NOT the narrow sales-tuned
 * beauty-qwen2.5-1.5b-lora adapter, since classifying a product from its own
 * description is outside what that adapter was trained to do (falls back to
 * OpenAI if the local model is unreachable/fails).
 *
 * 2026-07-18: Skin Type and Hair Type used to be separate columns (G, H);
 * they were merged into a single "Skin/Hair Type" column at G (folding Hair
 * Type's values in, then deleting the Hair Type column), so everything from
 * H onward shifted left by one — Routine Step moved from J to I accordingly.
 * This script only ever classifies skin_type (never hair type — unaffected
 * by the merge in that sense), and only fills column G when it's empty, so
 * it still never overwrites a haircare product's already-merged hair-type
 * text.
 *
 * Only ever writes single-cell ranges (G{row} or I{row} individually) — never
 * a contiguous range — so there is no risk of touching the In Stock column in
 * between, and never overwrites a cell that already has a value (additive
 * only).
 *
 * Usage:
 *   node scripts/tagProductsSkinType.js                  # dry run — prints proposed tags, writes nothing
 *   node scripts/tagProductsSkinType.js --write          # writes to the Sheet for real
 *   node scripts/tagProductsSkinType.js --write --limit 20   # test on a small batch first
 */

const fetch = require('node-fetch');
const googleSheets = require('../src/services/googleSheets');
const openaiService = require('../src/services/openaiService');
const config = require('../src/config');

const CLASSIFIER_MODEL = 'gemma2:2b-instruct-q4_K_M';
const SKIN_TYPES = ['oily', 'dry', 'combination', 'sensitive'];
const ROUTINE_STEPS = ['Cleanser', 'Toner', 'Serum', 'Moisturizer', 'Sunscreen', 'Mask', 'Other'];
const PRODUCTS_RANGE = 'Products!A2:I';
const ROUTINE_STEP_HEADER_CELL = 'Products!I1';
const REQUEST_TIMEOUT_MS = 20 * 1000;

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--write');
const limitFlagIndex = args.indexOf('--limit');
const LIMIT = limitFlagIndex !== -1 ? parseInt(args[limitFlagIndex + 1], 10) : Infinity;

const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    skin_type: { type: 'array', items: { type: 'string', enum: SKIN_TYPES } },
    routine_step: { type: 'string', enum: ROUTINE_STEPS },
  },
  required: ['skin_type', 'routine_step'],
  additionalProperties: false,
};

function buildClassifierPrompt(product) {
  return (
    `حلل بيانات منتج التجميل ده وصنّفه:\n\n` +
    `اسم المنتج: ${product.name}\n` +
    `الفئة: ${product.category}\n` +
    `الوصف: ${product.description || 'غير متاح'}\n` +
    `الفوائد: ${product.benefits || 'غير متاحة'}\n\n` +
    `skin_type: استنتج من الاسم/الوصف نوع/أنواع البشرة المناسبة (ممكن أكتر من نوع من oily/dry/combination/sensitive). ` +
    `لو المنتج مش لعناية البشرة (شعر/ميكب/جسم) أو مفيش دليل واضح في النص، رجّع مصفوفة فاضية [].\n` +
    `routine_step: لو المنتج غسول رجّع Cleanser، تونر رجّع Toner، سيروم رجّع Serum، مرطب/كريم ترطيب رجّع Moisturizer، ` +
    `واقي شمس رجّع Sunscreen، ماسك رجّع Mask. أي حاجة تانية (حتى لو في فئة العناية بالبشرة) رجّع Other.`
  );
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function classifyWithLocalModel(product) {
  const res = await withTimeout(
    fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        messages: [{ role: 'user', content: buildClassifierPrompt(product) }],
        format: CLASSIFIER_SCHEMA,
        stream: false,
        options: { temperature: 0.1 },
      }),
    }),
    REQUEST_TIMEOUT_MS
  );
  if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.message.content);
}

async function classifyWithOpenAiFallback(product) {
  const systemPrompt =
    `You classify a cosmetics product. Reply with ONLY a JSON object matching this shape, no other text:\n` +
    `{"skin_type": string[] (subset of ${JSON.stringify(SKIN_TYPES)}, [] if not skin-relevant or unclear), ` +
    `"routine_step": string (one of ${JSON.stringify(ROUTINE_STEPS)}, "Other" if not a core skincare routine step)}`;
  const userPrompt = `Name: ${product.name}\nCategory: ${product.category}\nDescription: ${product.description || 'N/A'}\nBenefits: ${product.benefits || 'N/A'}`;
  const reply = await openaiService.generateReply(systemPrompt, userPrompt);
  if (!reply) throw new Error('OpenAI fallback returned nothing');
  return JSON.parse(reply);
}

async function classifyProduct(product) {
  let parsed;
  try {
    parsed = await classifyWithLocalModel(product);
  } catch (err) {
    console.warn(`  local model classification failed (${err.message}), falling back to OpenAI...`);
    parsed = await classifyWithOpenAiFallback(product);
  }
  const skinType = Array.isArray(parsed.skin_type) ? parsed.skin_type.filter((t) => SKIN_TYPES.includes(t)) : [];
  const routineStep = ROUTINE_STEPS.includes(parsed.routine_step) ? parsed.routine_step : 'Other';
  return { skinType, routineStep };
}

async function ensureRoutineStepHeader(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: config.googleSheetId, range: ROUTINE_STEP_HEADER_CELL });
  const current = (res.data.values && res.data.values[0] && res.data.values[0][0]) || '';
  if (current) {
    console.log(`Column J header already set to "${current}".`);
    return;
  }
  if (DRY_RUN) {
    console.log(`[dry-run] Would set ${ROUTINE_STEP_HEADER_CELL} header to "Routine Step".`);
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.googleSheetId,
    range: ROUTINE_STEP_HEADER_CELL,
    valueInputOption: 'RAW',
    requestBody: { values: [['Routine Step']] },
  });
  console.log(`Set ${ROUTINE_STEP_HEADER_CELL} header to "Routine Step".`);
}

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN (no changes will be written; pass --write to apply) ===' : '=== WRITE MODE — changes will be saved to the Sheet ===');

  await googleSheets.init();
  const sheets = googleSheets.getClient();
  if (!sheets) throw new Error('Google Sheets client not available — check GOOGLE_SHEET_ID/credentials.');

  await ensureRoutineStepHeader(sheets);

  const res = await sheets.spreadsheets.values.get({ spreadsheetId: config.googleSheetId, range: PRODUCTS_RANGE });
  const rows = res.data.values || [];
  console.log(`Fetched ${rows.length} product rows.\n`);

  const skinTypeUpdates = [];
  const routineStepUpdates = [];
  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += 1) {
    if (processed >= LIMIT) break;
    const row = rows[i];
    const [, name, category, , description, benefits, skinType, , routineStep] = row;
    if (!name || !category) continue;

    const needsSkinType = !skinType || !skinType.trim();
    const needsRoutineStep = !routineStep || !routineStep.trim();
    if (!needsSkinType && !needsRoutineStep) {
      skipped += 1;
      continue;
    }

    const rowNumber = i + 2; // +2: header row + 1-based indexing
    processed += 1;
    try {
      const result = await classifyProduct({ name, category, description, benefits });
      const skinTypeStr = result.skinType.join(', ');
      console.log(`[${processed}] row ${rowNumber} "${name}" -> skinType: ${skinTypeStr || '(none)'}${needsSkinType ? '' : ' (kept existing)'} | routineStep: ${result.routineStep}${needsRoutineStep ? '' : ' (kept existing)'}`);

      if (needsSkinType) skinTypeUpdates.push({ range: `Products!G${rowNumber}`, values: [[skinTypeStr]] });
      if (needsRoutineStep) routineStepUpdates.push({ range: `Products!I${rowNumber}`, values: [[result.routineStep]] });
    } catch (err) {
      failed += 1;
      console.error(`  FAILED to classify row ${rowNumber} "${name}": ${err.message}`);
    }
  }

  console.log(`\nProcessed ${processed}, skipped ${skipped} (already fully tagged), failed ${failed}.`);
  const allUpdates = [...skinTypeUpdates, ...routineStepUpdates];

  if (DRY_RUN) {
    console.log(`\n[dry-run] ${allUpdates.length} cell update(s) would be written. Re-run with --write to apply.`);
    return;
  }

  if (allUpdates.length === 0) {
    console.log('\nNothing to write.');
    return;
  }

  console.log(`\nWriting ${allUpdates.length} cell update(s) to the Sheet in one batch...`);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.googleSheetId,
    requestBody: { valueInputOption: 'RAW', data: allUpdates },
  });
  console.log('Done.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
