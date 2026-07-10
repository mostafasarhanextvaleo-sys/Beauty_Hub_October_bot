const config = require('../config');
const logger = require('../utils/logger');
const googleSheets = require('./googleSheets');

const CATEGORY_VALUES = ['skincare', 'haircare', 'makeup', 'bodycare'];
const PRODUCTS_RANGE = `${googleSheets.PRODUCTS_SHEET_NAME}!A2:I`;

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

function rowToProduct(row) {
  const [id, name, category, price, description, benefits, skinType, hairType, inStock] = row;
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
    skinType: splitList(skinType),
    hairType: splitList(hairType),
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
