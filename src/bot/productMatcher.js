const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const googleSheetsProducts = require('../services/googleSheetsProducts');

const PRODUCTS_PATH = path.join(__dirname, '..', '..', 'products.json');
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let products = [];
let source = 'local'; // 'local' | 'google-sheets'
let refreshTimer = null;

function loadLocalProducts() {
  try {
    if (!fs.existsSync(PRODUCTS_PATH)) {
      logger.warn(`products.json not found at ${PRODUCTS_PATH}. Product recommendations disabled.`);
      products = [];
      return;
    }
    const raw = fs.readFileSync(PRODUCTS_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    products = Array.isArray(parsed) ? parsed : [];
    source = 'local';
    logger.info(`Loaded ${products.length} products from products.json`);
  } catch (err) {
    logger.error('Failed to load products.json. Continuing without product data.', err);
    products = [];
  }
}

async function refreshFromGoogleSheets() {
  try {
    const remoteProducts = await googleSheetsProducts.fetchProducts();
    if (remoteProducts === null) {
      // Google Sheets not configured or the fetch failed — keep whatever is currently loaded.
      return false;
    }
    products = remoteProducts;
    source = 'google-sheets';
    logger.info(`Loaded ${products.length} products from the Google Sheet "Products" tab.`);
    return true;
  } catch (err) {
    logger.error('Failed to refresh products from Google Sheets. Keeping the last known product list.', err);
    return false;
  }
}

function startAutoRefresh(intervalMs = AUTO_REFRESH_INTERVAL_MS) {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refreshFromGoogleSheets();
  }, intervalMs);
  if (refreshTimer.unref) refreshTimer.unref();
}

loadLocalProducts();

function findByCategory(category) {
  return products.filter((p) => p.category === category && p.inStock !== false);
}

// 2026-07-18: product.skinType/product.hairType merged into a single
// product.targetType field in the Sheet and in rowToProduct() (see
// googleSheetsProducts.js). findBySkinType/findByHairType keep their
// original names and signatures unchanged — callers in agent.js (the legacy
// rule-based flow) still ask "is there a skincare product tagged for this
// skin type" or "a haircare product tagged for this hair type" exactly as
// before; only the underlying storage field they both read now shares one
// name, since a given product only ever carried one type of tag anyway
// (skincare products: skin type, haircare products: hair type — confirmed
// mutually exclusive across the catalog before merging).
function findByTargetType(category, type) {
  return products.filter(
    (p) =>
      p.category === category &&
      p.inStock !== false &&
      Array.isArray(p.targetType) &&
      p.targetType.includes(type)
  );
}

function findBySkinType(category, skinType) {
  return findByTargetType(category, skinType);
}

function findByHairType(category, hairType) {
  return findByTargetType(category, hairType);
}

function findBestMatch({ category, skinType, hairType, excludeIds = [] }) {
  let matches = [];

  if (category === 'skincare' && skinType) {
    matches = findBySkinType('skincare', skinType);
  } else if (category === 'haircare' && hairType) {
    matches = findByHairType('haircare', hairType);
  } else if (category) {
    matches = findByCategory(category);
  }

  if (matches.length === 0 && category) {
    matches = findByCategory(category);
  }

  if (matches.length === 0) return null;

  // Prefer products not already shown to this customer this conversation, so
  // repeat questions (or a category switch-back) don't keep surfacing the same
  // item every time out of hundreds of catalog options. Once everything
  // matching has been shown, allow repeats rather than returning nothing.
  const unseen = matches.filter((p) => !excludeIds.includes(p.id));
  const pool = unseen.length > 0 ? unseen : matches;

  return pool[Math.floor(Math.random() * pool.length)];
}

function reload() {
  loadLocalProducts();
}

function getSource() {
  return source;
}

function getProductCount() {
  return products.length;
}

function getAllProducts() {
  return products;
}

function getById(id) {
  return products.find((p) => p.id === id) || null;
}

module.exports = {
  findBestMatch,
  findByCategory,
  reload,
  refreshFromGoogleSheets,
  startAutoRefresh,
  getSource,
  getProductCount,
  getAllProducts,
  getById,
};
