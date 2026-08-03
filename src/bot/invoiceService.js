const logger = require('../utils/logger');
const config = require('../config');
const googleSheets = require('../services/googleSheets');

// Best-effort and fully additive — called after the Confirmed_Orders row
// already exists (see campaignWorker.js's handleOrderConfirmed), so any
// failure here must never retroactively affect that row or anything
// upstream of it. There's no PDF/upload step anymore: the invoice is
// rendered fresh on every request by GET /invoice/:rowNumber (src/index.js),
// so this just writes that link into the sheet.
async function generateAndAttachInvoice({ rowNumber }) {
  if (!rowNumber) return;
  if (!config.publicBaseUrl) {
    logger.warn(`Skipping invoice link for Confirmed_Orders row ${rowNumber} — PUBLIC_BASE_URL is not set in .env.`);
    return;
  }
  try {
    const url = `${config.publicBaseUrl}/invoice/${rowNumber}?token=${config.invoiceViewToken}`;
    await googleSheets.attachInvoiceLinks(rowNumber, url);
    logger.success(`Invoice link attached for Confirmed_Orders row ${rowNumber}.`);
  } catch (err) {
    logger.error(`Attaching invoice link failed for Confirmed_Orders row ${rowNumber} (the order row itself is unaffected).`, err);
  }
}

module.exports = { generateAndAttachInvoice };
