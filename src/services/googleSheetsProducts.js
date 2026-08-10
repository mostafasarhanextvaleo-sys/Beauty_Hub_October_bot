const config = require('../config');
const logger = require('../utils/logger');
const googleSheets = require('./googleSheets');

const CATEGORY_VALUES = ['skincare', 'haircare', 'makeup', 'bodycare'];
// Range already reached column J before this field existed (see the old
// comment this replaced — J was fetched-but-unused, as headroom for exactly
// this kind of addition). Column I ("Routine Step") stays unread by this
// code; J is now "Image URL" (2026-08-09 addition, outgoing product-photo
// feature — see rowToProduct below).
const PRODUCTS_RANGE = `${googleSheets.PRODUCTS_SHEET_NAME}!A2:J`;

function splitList(value) {
  if (!value) return [];
  return value
    .toString()
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function parseBool(value) {
  if (value === undefined || value === null || value === '') return true;
  const normalized = value.toString().trim().toLowerCase();
  return !['false', 'no', '0', 'لا'].includes(normalized);
}

// 2026-07-18: "Skin Type" and "Hair Type" were merged into a single "Skin/Hair
// Type" column in the Sheet (folding Hair Type's values into Skin Type,
// comma-separated where a row had both, then deleting the Hair Type column —
// see the migration this was run alongside). Column G is now that merged
// column; everything from H onward shifted left by one. `targetType` is the
// single in-memory field name replacing both `skinType`/`hairType`.
// Column J, "Image URL" (2026-08-09) — the ONLY source the bot is allowed to
// send a product photo from (see productImageRequestDetector.js /
// llmAgent.js's handleProductImageRequest). Deliberately just a trimmed
// passthrough with no validation here: an empty/missing cell must produce
// imageUrl: '' (falsy), which the send path already treats as "no photo yet,
// tell the customer gracefully" — never a broken link or a guessed image.
function rowToProduct(row) {
  const [id, name, category, price, description, benefits, targetType, inStock, , imageUrl] = row;
  const normalizedCategory = (category || '').toString().trim().toLowerCase();

  if (!name || !normalizedCategory) return null;

  if (!CATEGORY_VALUES.includes(normalizedCategory)) {
    logger.warn(
      `Skipped product "${name}" from Google Sheet — invalid category "${category}". Must be one of: ${CATEGORY_VALUES.join(', ')}`
    );
    return null;
  }

  return {
    id: (id || '').toString().trim(),
    name: name.toString().trim(),
    category: normalizedCategory,
    price: (price || '').toString().trim(),
    description: (description || '').toString().trim(),
    benefits: splitList(benefits),
    targetType: splitList(targetType),
    inStock: parseBool(inStock),
    imageUrl: (imageUrl || '').toString().trim(),
  };
}

async function fetchProducts() {
  const client = googleSheets.getClient();
  if (!client) return null;

  try {
    const result = await googleSheets.sheetsCall(() =>
      client.spreadsheets.values.get(
        { spreadsheetId: config.googleSheetId, range: PRODUCTS_RANGE },
        { timeout: googleSheets.REQUEST_TIMEOUT_MS }
      )
    );
    const rows = result.data.values || [];
    googleSheets.recordSuccess();
    return rows.map(rowToProduct).filter(Boolean);
  } catch (err) {
    logger.error('Failed to fetch products from the Google Sheet "Products" tab.', err);
    return null;
  }
}

module.exports = { fetchProducts };
