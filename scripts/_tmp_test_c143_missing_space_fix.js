// Throwaway isolated check for the 2026-08-13 C143/C016 repeated
// "product-id-not-in-reply-text" warning. Reads the real live Products sheet
// (read-only) to confirm C143's actual catalog entry, then feeds fabricated
// candidates/replies through validateModelOutput — never touches any real
// session or production conversation data.
const googleSheets = require('../src/services/googleSheets');
const productMatcher = require('../src/bot/productMatcher');
const { validateModelOutput } = require('../src/bot/llmAgent');

async function main() {
  await googleSheets.init();
  const refreshed = await productMatcher.refreshFromGoogleSheets();
  if (!refreshed) {
    console.error('Could not refresh from the live Products sheet — aborting (this check needs the real C143 row).');
    process.exit(1);
  }

  const c143 = productMatcher.getAllProducts().find((p) => p.id === 'C143');
  if (!c143) {
    console.error('FAIL: C143 not found in the live catalog');
    process.exit(1);
  }
  console.log('Live C143 catalog entry:', JSON.stringify(c143.name));

  let failures = 0;
  function check(label, output, candidates, expectMentioned) {
    const result = validateModelOutput(output, candidates);
    const gotMentioned = result ? result.mentioned_product_ids : null;
    const ok = JSON.stringify(gotMentioned) === JSON.stringify(expectMentioned);
    console.log(`${ok ? 'PASS' : 'FAIL'}: ${label} -> mentioned_product_ids=${JSON.stringify(gotMentioned)} (expected ${JSON.stringify(expectMentioned)})`);
    if (!ok) failures++;
  }

  // Sara's natural reply writes "60 مل" WITH a space (standard Arabic), while
  // the catalog row itself has "60مل" with none — this is exactly the shape
  // of reply that used to get C143 dropped (and logged) on every turn.
  check(
    'C143 natural reply (real space before unit) keeps the id',
    {
      intent: 'PRODUCT_SEARCH',
      mentioned_product_ids: ['C143'],
      price_quoted: null,
      routine_bundle_suggested_id: null,
      routine_bundle_price_quoted: null,
      reply_text: `تحبي تجربي ${c143.name.replace('60مل', '60 مل')}؟ هيساعدك توحدي لون بشرتك.`,
    },
    [c143],
    ['C143']
  );

  // A reply that genuinely never names the product should still be dropped —
  // the fix narrows false positives, it doesn't disable the check.
  check(
    'genuinely unmentioned id is still dropped',
    {
      intent: 'PRODUCT_SEARCH',
      mentioned_product_ids: ['C143'],
      price_quoted: null,
      routine_bundle_suggested_id: null,
      routine_bundle_price_quoted: null,
      reply_text: 'أهلاً بيكي، إزاي أقدر أساعدك النهاردة؟',
    },
    [c143],
    []
  );

  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
