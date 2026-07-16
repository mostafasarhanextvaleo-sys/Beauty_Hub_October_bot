/**
 * One-time (idempotent) migration for the "Leads" tab: moves the existing
 * Conversation History cell VALUES (the long chat transcripts that were
 * making rows balloon in height) into cell NOTES, replacing the visible
 * value with a short indicator. Pairs with the logging-side change in
 * src/services/googleSheets.js (appendLead now writes new history straight
 * to a Note going forward) — this script only backfills rows written before
 * that change.
 *
 * Idempotent: skips any row whose K cell value already IS the indicator
 * text, so re-running after new leads have come in (which already write the
 * indicator + Note themselves) is a safe no-op for those rows.
 *
 * Usage:
 *   node scripts/migrateHistoryToNotes.js             # dry run — prints what would change
 *   node scripts/migrateHistoryToNotes.js --write      # applies it for real
 */

const googleSheets = require('../src/services/googleSheets');
const config = require('../src/config');
const logger = require('../src/utils/logger');

const DRY_RUN = !process.argv.includes('--write');

async function main() {
  await googleSheets.init();
  const sheets = googleSheets.getClient();
  if (!sheets) throw new Error('Google Sheets client not available — check GOOGLE_SHEET_ID and credentials.json.');

  const leadsSheetName = googleSheets.LEADS_SHEET_NAME;
  const indicator = googleSheets.HISTORY_INDICATOR_TEXT;
  const historyColIndex = googleSheets.CONVERSATION_HISTORY_COLUMN_INDEX;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: config.googleSheetId });
  const leadsSheet = (meta.data.sheets || []).find((s) => s.properties.title === leadsSheetName);
  if (!leadsSheet) throw new Error(`"${leadsSheetName}" tab not found.`);
  const sheetId = leadsSheet.properties.sheetId;

  const values = await sheets.spreadsheets.values.get({
    spreadsheetId: config.googleSheetId,
    range: `${leadsSheetName}!K2:K`,
  });
  const rows = values.data.values || [];

  const requests = [];
  let migratedCount = 0;
  rows.forEach((row, i) => {
    const cellValue = row[0] || '';
    if (!cellValue || cellValue === indicator) return; // empty or already migrated

    const rowNumber = i + 2; // +2: 1-based, past the header row
    migratedCount += 1;
    logger.info(`Row ${rowNumber}: migrating ${cellValue.length} chars of history to a Note.`);

    requests.push({
      updateCells: {
        range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: historyColIndex, endColumnIndex: historyColIndex + 1 },
        rows: [{ values: [{ userEnteredValue: { stringValue: indicator }, note: googleSheets.truncateHistoryForNote(cellValue) }] }],
        fields: 'userEnteredValue,note',
      },
    });
  });

  if (migratedCount === 0) {
    logger.success('Nothing to migrate — every row already has the compact indicator (or is empty).');
    return;
  }

  if (DRY_RUN) {
    logger.info(`DRY RUN: would migrate ${migratedCount} row(s). Re-run with --write to apply.`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({ spreadsheetId: config.googleSheetId, requestBody: { requests } });
  logger.success(`Migrated ${migratedCount} row(s): full history moved to Notes, cell now shows "${indicator}".`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Failed to migrate Conversation History to Notes.', err);
    process.exit(1);
  });
