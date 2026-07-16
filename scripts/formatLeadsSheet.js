/**
 * One-time (re-runnable/idempotent) visual + operational upgrade for the
 * "Leads" tab of the "Beauty Hub October Sales" Google Sheet.
 *
 * Deliberately does NOT physically reorder columns: src/services/googleSheets.js's
 * appendLead() writes new/updated rows to fixed positions (A:K, with J
 * reserved as a staff-owned manual column it never touches). Moving columns
 * around in the Sheet UI would silently desync those positions from what the
 * bot writes on the next lead, corrupting live data. Instead, this makes the
 * core operational columns (Customer Name, Phone, Order Status, Notes) pop
 * visually via a distinct header highlight, while leaving column order and
 * all existing cell values untouched.
 *
 * Adds one new column, L "Follow-up Date" — appended after the existing K
 * (Conversation History), so it's outside the A:K range appendLead() writes
 * to and is exclusively staff-maintained, same pattern as J ("human
 * interaction").
 *
 * What it does:
 *   1. Freezes the header row.
 *   2. Adds "Follow-up Date" as a new manual column (L), date-formatted.
 *   3. Styles the header row (dark bg, white bold text), with the core
 *      lead-tracking columns (Customer Name, Phone, Order Status, Notes,
 *      Follow-up Date) highlighted in a distinct accent color.
 *   4. Zebra-stripes the data rows (banded range, header excluded since it's
 *      already styled in step 3).
 *   5. Adds a dropdown (non-strict — won't reject any existing/future value
 *      outside the list) on Order Status with the seven values actually used
 *      by the codebase, in lifecycle order: Pending / In Progress / Out for
 *      Delivery / Delivered / Completed / Issue / Cancelled.
 *   6. Adds soft conditional-formatting colors on Order Status: blue for
 *      Pending, yellow for In Progress, orange for Out for Delivery, cyan
 *      for Delivered, green for Completed, purple for Issue, red for
 *      Cancelled.
 *   7. Auto-resizes all columns so nothing is clipped.
 *
 * Touches only the Leads tab's formatting/structure — no other tab, and no
 * existing cell values.
 *
 * Usage: node scripts/formatLeadsSheet.js
 */

const googleSheets = require('../src/services/googleSheets');
const config = require('../src/config');
const logger = require('../src/utils/logger');

const LEADS_SHEET_NAME = 'Leads';
const HEADER_ROW_COUNT = 1;
const TOTAL_COLUMNS = 12; // A..L (see the LEADS_HEADERS correction note in googleSheets.js — "human interaction" was removed, Alternative Phone added, net column count unchanged)

// Columns (0-indexed) considered the "core" operational set for daily
// follow-up — highlighted distinctly in the header row.
const CORE_COLUMN_INDEXES = {
  customerName: 1, // B
  phone: 2, // C
  orderStatus: 6, // G
  notes: 8, // I
  followUpDate: 10, // K
  altPhone: 11, // L (new)
};

const HEADER_BG = { red: 0.204, green: 0.286, blue: 0.369 }; // slate navy #34495e
const HEADER_TEXT = { red: 1, green: 1, blue: 1 };
const CORE_HEADER_BG = { red: 1, green: 0.851, blue: 0.4 }; // soft gold #FFD966
const CORE_HEADER_TEXT = { red: 0.176, green: 0.176, blue: 0.176 };

const ZEBRA_COLOR_1 = { red: 1, green: 1, blue: 1 };
const ZEBRA_COLOR_2 = { red: 0.953, green: 0.961, blue: 0.973 }; // #F3F4F6

const STATUS_GREEN_BG = { red: 0.851, green: 0.918, blue: 0.827 }; // #D9EAD3
const STATUS_GREEN_TEXT = { red: 0.153, green: 0.306, blue: 0.075 }; // #274E13
const STATUS_YELLOW_BG = { red: 1, green: 0.949, blue: 0.8 }; // #FFF2CC
const STATUS_YELLOW_TEXT = { red: 0.498, green: 0.376, blue: 0 }; // #7F6000
const STATUS_RED_BG = { red: 0.957, green: 0.8, blue: 0.8 }; // #F4CCCC
const STATUS_RED_TEXT = { red: 0.6, green: 0, blue: 0 }; // #990000
const STATUS_BLUE_BG = { red: 0.812, green: 0.886, blue: 0.953 }; // #CFE2F3 — Pending: data still incomplete
const STATUS_BLUE_TEXT = { red: 0.027, green: 0.216, blue: 0.388 }; // #073763
const STATUS_ORANGE_BG = { red: 0.988, green: 0.898, blue: 0.804 }; // #FCE5CD — Out for Delivery: in transit
const STATUS_ORANGE_TEXT = { red: 0.706, green: 0.373, blue: 0.024 }; // #B45F06
const STATUS_CYAN_BG = { red: 0.816, green: 0.878, blue: 0.89 }; // #D0E0E3 — Delivered: awaiting customer confirmation
const STATUS_CYAN_TEXT = { red: 0.047, green: 0.204, blue: 0.239 }; // #0C343D
const STATUS_PURPLE_BG = { red: 0.851, green: 0.824, blue: 0.914 }; // #D9D2E9 — Issue: needs attention now (distinct from Cancelled's plain red)
const STATUS_PURPLE_TEXT = { red: 0.125, green: 0.071, blue: 0.302 }; // #20124D

// Sequential lifecycle order, per the store owner's spec (2026-07-16):
// data collection -> ready to pack -> shipped -> dropped off -> customer
// confirmed OR flagged a problem -> (or cancelled at any point).
const ORDER_STATUS_OPTIONS = ['Pending', 'In Progress', 'Out for Delivery', 'Delivered', 'Completed', 'Issue', 'Cancelled'];

async function getLeadsSheetId(sheets) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.googleSheetId });
  const leadsSheet = (meta.data.sheets || []).find((s) => s.properties.title === LEADS_SHEET_NAME);
  if (!leadsSheet) throw new Error(`"${LEADS_SHEET_NAME}" tab not found in the spreadsheet.`);
  return { sheetId: leadsSheet.properties.sheetId, rowCount: leadsSheet.properties.gridProperties.rowCount };
}


function headerFormatRequest(sheetId) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: HEADER_ROW_COUNT, startColumnIndex: 0, endColumnIndex: TOTAL_COLUMNS },
      cell: {
        userEnteredFormat: {
          backgroundColor: HEADER_BG,
          textFormat: { foregroundColor: HEADER_TEXT, bold: true, fontSize: 10 },
          verticalAlignment: 'MIDDLE',
          wrapStrategy: 'WRAP',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)',
    },
  };
}

function coreHeaderHighlightRequests(sheetId) {
  return Object.values(CORE_COLUMN_INDEXES).map((colIndex) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: HEADER_ROW_COUNT, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
      cell: {
        userEnteredFormat: {
          backgroundColor: CORE_HEADER_BG,
          textFormat: { foregroundColor: CORE_HEADER_TEXT, bold: true, fontSize: 10 },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)',
    },
  }));
}

function freezeHeaderRequest(sheetId) {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: HEADER_ROW_COUNT } },
      fields: 'gridProperties.frozenRowCount',
    },
  };
}

function zebraStripingRequest(sheetId, rowCount) {
  return {
    addBanding: {
      bandedRange: {
        range: { sheetId, startRowIndex: HEADER_ROW_COUNT, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: TOTAL_COLUMNS },
        rowProperties: { firstBandColor: ZEBRA_COLOR_1, secondBandColor: ZEBRA_COLOR_2 },
      },
    },
  };
}

function followUpDateFormatRequest(sheetId, rowCount) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: HEADER_ROW_COUNT, endRowIndex: rowCount, startColumnIndex: CORE_COLUMN_INDEXES.followUpDate, endColumnIndex: CORE_COLUMN_INDEXES.followUpDate + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  };
}

function orderStatusDropdownRequest(sheetId, rowCount) {
  return {
    setDataValidation: {
      range: { sheetId, startRowIndex: HEADER_ROW_COUNT, endRowIndex: rowCount, startColumnIndex: CORE_COLUMN_INDEXES.orderStatus, endColumnIndex: CORE_COLUMN_INDEXES.orderStatus + 1 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: ORDER_STATUS_OPTIONS.map((v) => ({ userEnteredValue: v })) },
        strict: false, // non-blocking: shows a dropdown but never rejects a value the bot (or staff) enters outside the list
        showCustomUi: true,
      },
    },
  };
}

function orderStatusConditionalFormatRequests(sheetId, rowCount) {
  const range = { sheetId, startRowIndex: HEADER_ROW_COUNT, endRowIndex: rowCount, startColumnIndex: CORE_COLUMN_INDEXES.orderStatus, endColumnIndex: CORE_COLUMN_INDEXES.orderStatus + 1 };
  const rule = (text, bg, fg) => ({
    addConditionalFormatRule: {
      rule: {
        ranges: [range],
        booleanRule: {
          condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] },
          format: { backgroundColor: bg, textFormat: { foregroundColor: fg, bold: true } },
        },
      },
      index: 0,
    },
  });
  return [
    rule('Completed', STATUS_GREEN_BG, STATUS_GREEN_TEXT),
    rule('In Progress', STATUS_YELLOW_BG, STATUS_YELLOW_TEXT),
    rule('Cancelled', STATUS_RED_BG, STATUS_RED_TEXT),
    rule('Pending', STATUS_BLUE_BG, STATUS_BLUE_TEXT),
    rule('Out for Delivery', STATUS_ORANGE_BG, STATUS_ORANGE_TEXT),
    rule('Delivered', STATUS_CYAN_BG, STATUS_CYAN_TEXT),
    rule('Issue', STATUS_PURPLE_BG, STATUS_PURPLE_TEXT),
  ];
}

function autoResizeRequest(sheetId) {
  return {
    autoResizeDimensions: {
      dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: TOTAL_COLUMNS },
    },
  };
}

async function main() {
  await googleSheets.init();
  const sheets = googleSheets.getClient();
  if (!sheets) {
    throw new Error('Google Sheets client not available — check GOOGLE_SHEET_ID and credentials.json.');
  }

  const { sheetId, rowCount } = await getLeadsSheetId(sheets);
  logger.info(`Formatting "${LEADS_SHEET_NAME}" tab (sheetId=${sheetId}, rowCount=${rowCount})...`);

  // Header row (including Follow-up Date and Alternative Phone) is handled
  // by googleSheets.init() above via LEADS_HEADERS/ensureHeaderRow — no
  // separate step needed here.

  // Conditional format rules must be added AFTER the corresponding data
  // validation/banding requests that touch the same range in some Sheets API
  // versions, but ordering within one batchUpdate call is otherwise safe —
  // requests are applied sequentially in array order.
  const requests = [
    freezeHeaderRequest(sheetId),
    headerFormatRequest(sheetId),
    ...coreHeaderHighlightRequests(sheetId),
    zebraStripingRequest(sheetId, rowCount),
    followUpDateFormatRequest(sheetId, rowCount),
    orderStatusDropdownRequest(sheetId, rowCount),
    ...orderStatusConditionalFormatRequests(sheetId, rowCount),
    autoResizeRequest(sheetId),
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.googleSheetId,
    requestBody: { requests },
  });

  logger.success(`"${LEADS_SHEET_NAME}" tab formatting applied: frozen header, zebra striping, core-column header highlight, Order Status dropdown + conditional colors, Follow-up Date column, auto-resized columns.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Failed to format the Leads sheet.', err);
    process.exit(1);
  });
