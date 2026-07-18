const config = require('../config');
const logger = require('../utils/logger');
const googleSheets = require('./googleSheets');

const CATEGORY_VALUES = ['skincare', 'haircare', 'makeup', 'bodycare'];
// Fetches one column past the last one this code actually reads (In Stock) —
// production's Sheet has an extra "Routine Step" column after In Stock
// (added by scripts/tagProductsSkinType.js) that this code has never read;
// widening the range rather than hardcoding an exact final letter means it
// keeps working unchanged whether that extra column exists or not, instead
// of silently truncating it or breaking if the sheet gains another column.
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
function rowToProduct(row) {
  const [id, name, category, price, description, benefits, targetType, inStock] = row;
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
  };
}

async function fetchProducts() {
  const client = googleSheets.getClient();
  if (!client) return null;

  try {
    const result = await client.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: PRODUCTS_RANGE },
      { timeout: googleSheets.REQUEST_TIMEOUT_MS }
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
