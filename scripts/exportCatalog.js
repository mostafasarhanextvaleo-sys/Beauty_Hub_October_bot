// Exports the live product catalog (Google Sheets "Products" tab, same
// source the bot itself uses — falls back to products.json only if Sheets is
// unreachable) into training-data/catalog.jsonl: one clean JSON object per
// product, ready to feed into fine-tuning/data-generation scripts.
//
// Usage: node scripts/exportCatalog.js

const fs = require('fs');
const path = require('path');
const googleSheets = require('../src/services/googleSheets');
const productMatcher = require('../src/bot/productMatcher');

const OUT_PATH = path.join(__dirname, '..', 'training-data', 'catalog.jsonl');

async function main() {
  await googleSheets.init();
  const refreshed = await productMatcher.refreshFromGoogleSheets();
  if (!refreshed) {
    console.error('Could not refresh from Google Sheets — aborting so we never write the stale local products.json as if it were the catalog.');
    process.exit(1);
  }

  const products = productMatcher.getAllProducts();
  const source = productMatcher.getSource();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const lines = products.map((p) => JSON.stringify(p)).join('\n') + '\n';
  fs.writeFileSync(OUT_PATH, lines);

  console.log(`Exported ${products.length} products (source: ${source}) to ${OUT_PATH}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to export catalog:', err);
  process.exit(1);
});
