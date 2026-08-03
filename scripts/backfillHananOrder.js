// One-time backfill (2026-08-03): a real completed order — "حنان نادي
// عبدالشافي الشافي", phone 201156630487, chatId 35351993254096@lid,
// غسول هيدرينسا (Hydrinsa Cleanser), 180£, confirmed 2026-07-18T06:28:58.177Z
// (see Order History) — predates the Confirmed_Orders/Targeted_Clients CRM
// tabs (built 2026-08-02) and was never backfilled, the same class of gap
// already fixed once for 201069041004. Order History only has 2 real orders
// ever logged, both now reconciled into the CRM tabs after this script.
//
// Idempotent: appendConfirmedOrder has its own dedup check, and
// upsertTargetedClient only inserts a new row for a chatId not already
// present — safe to re-run.
const googleSheets = require('../src/services/googleSheets');
const invoiceService = require('../src/bot/invoiceService');
const logger = require('../src/utils/logger');

const CHAT_ID = '35351993254096@lid';
const ORDER = {
  customerName: 'حنان نادي عبدالشافي الشافي',
  phone: '201156630487',
  address: 'اكتوبر',
  products: 'غسول هيدرينسا (Hydrinsa Cleanser)',
  totalPrice: '180£',
};
const ORIGINAL_ORDER_DATE = '2026-07-18T06:28:58.177Z';

async function main() {
  await googleSheets.init();

  const existingRows = await googleSheets.getTargetedClientsRows();
  const alreadyInCrm = existingRows.find((r) => r.chatId === CHAT_ID);
  if (alreadyInCrm && alreadyInCrm.campaignStatus === 'ORDERED') {
    logger.info(`${CHAT_ID} is already marked ORDERED in Targeted_Clients — nothing to do.`);
    return;
  }

  const appended = await googleSheets.appendConfirmedOrder(ORDER);
  if (!appended) {
    logger.warn('appendConfirmedOrder returned null (likely the dedup guard, or Sheets disabled) — check Confirmed_Orders manually before re-running.');
    return;
  }
  logger.success(`Appended Confirmed_Orders row ${appended.rowNumber} for ${ORDER.customerName}.`);

  await googleSheets.upsertTargetedClient(CHAT_ID, {
    phoneNumber: ORDER.phone,
    customerName: ORDER.customerName,
    category: ORDER.products,
    leadSource: 'طلب مؤكد قديم (2026-07-18) — أُضيف يدويًا بعد اكتشاف الفجوة في مراجعة 2026-08-03',
    campaignStatus: 'ORDERED',
    orderedAt: ORIGINAL_ORDER_DATE,
  });
  logger.success(`Upserted Targeted_Clients row for ${CHAT_ID} as ORDERED.`);

  await invoiceService.generateAndAttachInvoice({ rowNumber: appended.rowNumber });
  logger.success(`Invoice link attached to Confirmed_Orders row ${appended.rowNumber}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Backfill failed.', err);
    process.exit(1);
  });
