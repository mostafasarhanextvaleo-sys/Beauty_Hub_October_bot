// One-time cleanup pass (2026-08-03): reclassifies Targeted_Clients rows
// that were sent *today* before classifyLeadForCampaign's new criteria
// (already-ordered / specialist-referral / avoid-standard-offer) existed.
// Reuses campaignWorker.js's classifyLeadForCampaign directly rather than
// reimplementing the keyword lists — same reasoning as its own export
// comment: single source of truth for the classification rules.
//
// Scope: only rows whose Sent At falls on today's date (the ones that could
// have gone out before this safeguard was live). Never touches rows already
// at the status the classifier would assign — those are no-ops, not writes.
//
// Usage: node scripts/cleanupCampaignClassification.js         (dry run)
//        node scripts/cleanupCampaignClassification.js --apply (writes)
const googleSheets = require('../src/services/googleSheets');
const { classifyLeadForCampaign } = require('../src/bot/campaignWorker');
const logger = require('../src/utils/logger');

const APPLY = process.argv.includes('--apply');
const todayPrefix = new Date().toISOString().slice(0, 10);

async function main() {
  await googleSheets.init();
  const rows = await googleSheets.getTargetedClientsRows();
  const sentToday = rows.filter((r) => (r.sentAt || '').startsWith(todayPrefix));

  logger.info(`Found ${sentToday.length} row(s) sent today (${todayPrefix}) out of ${rows.length} total Targeted_Clients rows.`);

  const changes = [];
  for (const row of sentToday) {
    const classification = classifyLeadForCampaign(row);
    if (classification.block && row.campaignStatus !== classification.status) {
      changes.push({ row, classification });
    }
  }

  if (changes.length === 0) {
    logger.success('No rows sent today match the new reclassification criteria — nothing to change.');
    return;
  }

  logger.info(`${changes.length} row(s) need reclassification:`);
  for (const { row, classification } of changes) {
    console.log(
      `  ${row.chatId} (${row.customerName || row.phoneNumber || 'no name'}): ${row.campaignStatus} -> ${classification.status}  [${classification.reason}]`
    );
  }

  if (!APPLY) {
    logger.info('Dry run only — re-run with --apply to write these changes to the sheet.');
    return;
  }

  for (const { row, classification } of changes) {
    // eslint-disable-next-line no-await-in-loop
    await googleSheets.upsertTargetedClient(row.chatId, { campaignStatus: classification.status });
    logger.success(`Reclassified ${row.chatId} -> ${classification.status}.`);
  }
  logger.success(`Cleanup pass complete — ${changes.length} row(s) reclassified.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Cleanup pass failed.', err);
    process.exit(1);
  });
