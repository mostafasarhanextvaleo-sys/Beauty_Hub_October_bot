const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');

const LEADS_SHEET_NAME = 'Leads';
const PRODUCTS_SHEET_NAME = 'Products';
const LOCAL_PRODUCTS_PATH = path.join(__dirname, '..', '..', 'products.json');

const LEADS_HEADERS = [
  'Date',
  'Customer Name',
  'Customer WhatsApp Number',
  'Customer Message',
  'Product Name',
  'Customer Need',
  'Order Status',
  'Delivery Address',
  'Notes',
];

const PRODUCTS_HEADERS = [
  'ID',
  'Name',
  'Category',
  'Price',
  'Description',
  'Benefits',
  'Skin Type',
  'Hair Type',
  'In Stock',
];

const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const REQUEST_TIMEOUT_MS = 15 * 1000; // never let a stalled network call block the bot
const STARTUP_TIMEOUT_MS = 20 * 1000;
const RETRY_INTERVAL_MS = 2 * 60 * 1000; // retry a failed/timed-out setup automatically
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // warn if nothing succeeded in this long
const STALENESS_CHECK_INTERVAL_MS = 5 * 60 * 1000;

let sheetsClient = null;
let enabled = false;
let retryTimer = null;
let lastSuccessAt = null;
let staleWarningLogged = false;
const recentLogs = new Map(); // phone -> { signature, timestamp }

// Called after any successful Sheets operation (setup, lead append, product
// fetch) so /health and the staleness monitor reflect real connectivity, not
// just whether Sheets was configured.
function recordSuccess() {
  lastSuccessAt = Date.now();
  staleWarningLogged = false;
}

function getLastSuccessAt() {
  return lastSuccessAt;
}

function isStale(thresholdMs = STALE_THRESHOLD_MS) {
  if (!enabled) return false; // intentionally disabled isn't "stale"
  if (!lastSuccessAt) return true;
  return Date.now() - lastSuccessAt > thresholdMs;
}

function checkStaleness() {
  if (!enabled || staleWarningLogged) return;
  if (isStale()) {
    staleWarningLogged = true;
    const minutesSince = lastSuccessAt ? Math.round((Date.now() - lastSuccessAt) / 60000) : null;
    logger.warn(
      `Google Sheets has not synced successfully in ${minutesSince !== null ? `${minutesSince} minutes` : 'a while'} — check network/credentials. The bot continues running normally with the last known data.`
    );
  }
}

function startStalenessMonitor(intervalMs = STALENESS_CHECK_INTERVAL_MS) {
  const timer = setInterval(checkStaleness, intervalMs);
  if (timer.unref) timer.unref();
}

function columnLetter(count) {
  return String.fromCharCode(64 + count); // 9 -> 'I'
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function init() {
  if (!config.googleSheetId) {
    logger.warn('GOOGLE_SHEET_ID is not set. Google Sheets logging is disabled. The WhatsApp bot will continue running without it.');
    enabled = false;
    return;
  }

  if (!fs.existsSync(config.credentialsAbsolutePath)) {
    logger.warn(
      `Google credentials file not found at "${config.credentialsAbsolutePath}". Google Sheets logging is disabled. The WhatsApp bot will continue running without it.`
    );
    enabled = false;
    return;
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: config.credentialsAbsolutePath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    sheetsClient = google.sheets({ version: 'v4', auth });
    enabled = true;
    logger.success('Google Sheets service initialized.');
    await withTimeout(ensureSheetsStructure(), STARTUP_TIMEOUT_MS, 'Google Sheet tab setup');
    recordSuccess();
    stopRetryTimer();
  } catch (err) {
    logger.error(
      `Google Sheets setup did not complete (network issue or slow response). The WhatsApp bot will continue running; Sheets logging is disabled until connectivity recovers — retrying automatically every ${RETRY_INTERVAL_MS / 1000}s.`,
      err
    );
    enabled = false;
    scheduleRetry();
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setInterval(() => {
    logger.info('Retrying Google Sheets connection...');
    init();
  }, RETRY_INTERVAL_MS);
  if (retryTimer.unref) retryTimer.unref();
}

function stopRetryTimer() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

async function ensureSheetsStructure() {
  if (!enabled) return;
  try {
    const meta = await sheetsClient.spreadsheets.get(
      { spreadsheetId: config.googleSheetId },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const existingTitles = (meta.data.sheets || []).map((s) => s.properties.title);

    const requests = [];
    if (!existingTitles.includes(LEADS_SHEET_NAME)) {
      requests.push({ addSheet: { properties: { title: LEADS_SHEET_NAME } } });
    }
    if (!existingTitles.includes(PRODUCTS_SHEET_NAME)) {
      requests.push({ addSheet: { properties: { title: PRODUCTS_SHEET_NAME } } });
    }

    if (requests.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate(
        { spreadsheetId: config.googleSheetId, requestBody: { requests } },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      logger.info(`Created Google Sheet tab(s): ${requests.map((r) => r.addSheet.properties.title).join(', ')}`);
    }

    await ensureHeaderRow(LEADS_SHEET_NAME, LEADS_HEADERS);
    await ensureProductsTabSeeded();
  } catch (err) {
    logger.error('Could not verify/create Google Sheet tabs. Continuing without full Sheets integration.', err);
  }
}

async function ensureHeaderRow(sheetName, headers) {
  if (!enabled) return;
  try {
    const range = `${sheetName}!A1:${columnLetter(headers.length)}1`;
    const result = await sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const values = result.data.values;
    if (!values || values.length === 0) {
      await sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      logger.info(`Header row created for "${sheetName}" tab.`);
    }
  } catch (err) {
    logger.error(`Could not verify/create header row for "${sheetName}" tab.`, err);
  }
}

function productToRow(product) {
  return [
    product.id || '',
    product.name || '',
    product.category || '',
    product.price || '',
    product.description || '',
    Array.isArray(product.benefits) ? product.benefits.join(', ') : '',
    Array.isArray(product.skinType) ? product.skinType.join(', ') : '',
    Array.isArray(product.hairType) ? product.hairType.join(', ') : '',
    product.inStock === false ? 'FALSE' : 'TRUE',
  ];
}

async function ensureProductsTabSeeded() {
  try {
    await ensureHeaderRow(PRODUCTS_SHEET_NAME, PRODUCTS_HEADERS);

    const result = await sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: `${PRODUCTS_SHEET_NAME}!A2:A2` },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const hasData = result.data.values && result.data.values.length > 0;
    if (hasData) return;

    if (!fs.existsSync(LOCAL_PRODUCTS_PATH)) return;
    const localProducts = JSON.parse(fs.readFileSync(LOCAL_PRODUCTS_PATH, 'utf-8'));
    if (!Array.isArray(localProducts) || localProducts.length === 0) return;

    const rows = localProducts.map(productToRow);
    await sheetsClient.spreadsheets.values.append(
      {
        spreadsheetId: config.googleSheetId,
        range: `${PRODUCTS_SHEET_NAME}!A:I`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    logger.success(`Seeded "Products" tab with ${rows.length} starter products from products.json.`);
  } catch (err) {
    logger.error('Could not seed "Products" tab with starter data.', err);
  }
}

function buildSignature(entry) {
  return `${entry.orderStatus}|${entry.productName || ''}`;
}

function isDuplicate(phone, entry) {
  const signature = buildSignature(entry);
  const previous = recentLogs.get(phone);
  if (!previous) return false;
  const withinWindow = Date.now() - previous.timestamp < DEDUP_WINDOW_MS;
  return withinWindow && previous.signature === signature;
}

async function appendLead(entry) {
  if (!enabled) {
    logger.warn('Google Sheets is not configured. Skipping lead log (WhatsApp bot continues normally).');
    return false;
  }

  const phone = entry.customerPhone;

  if (isDuplicate(phone, entry)) {
    logger.info(`Skipped duplicate Google Sheet log for ${phone} (no change in status/product).`);
    return false;
  }

  const row = [
    new Date().toISOString(),
    entry.customerName || '',
    phone || '',
    entry.customerMessage || '',
    entry.productName || '',
    entry.customerNeed || '',
    entry.orderStatus || '',
    entry.deliveryAddress || '',
    entry.notes || '',
  ];

  try {
    await sheetsClient.spreadsheets.values.append(
      {
        spreadsheetId: config.googleSheetId,
        range: `${LEADS_SHEET_NAME}!A:I`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    recentLogs.set(phone, { signature: buildSignature(entry), timestamp: Date.now() });
    recordSuccess();
    logger.success(`Google Sheet log saved for ${phone} (status: ${entry.orderStatus}).`);
    return true;
  } catch (err) {
    logger.error('Failed to append row to Google Sheet. WhatsApp bot continues normally.', err);
    return false;
  }
}

function isEnabled() {
  return enabled;
}

function getClient() {
  return enabled ? sheetsClient : null;
}

module.exports = {
  init,
  appendLead,
  isEnabled,
  getClient,
  recordSuccess,
  getLastSuccessAt,
  isStale,
  startStalenessMonitor,
  PRODUCTS_SHEET_NAME,
  REQUEST_TIMEOUT_MS,
};
