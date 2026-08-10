const logger = require('../utils/logger');
const config = require('../config');
const googleSheets = require('../services/googleSheets');

// Best-effort and fully additive — called after the Confirmed_Orders row
// already exists (see campaignWorker.js's handleOrderConfirmed), so any
// failure here must never retroactively affect that row or anything
// upstream of it. There's no PDF/upload step anymore: the invoice is
// rendered fresh on every request by GET /invoice/:rowNumber (src/index.js),
// so this just writes that link into the sheet.
//
// Returns { url } only when the link was genuinely written (attachInvoiceLinks
// now reports this itself, rather than this function inferring success from
// "didn't throw" — see the 2026-08-09 fix on attachInvoiceLinks, prompted by
// a real standalone-script run that logged "attached" while Sheets was
// disabled and nothing was actually written). Returns null on any skip or
// failure — callers that need a real link before texting a customer
// (orderPipeline.js) must check for this rather than assume success.
async function generateAndAttachInvoice({ rowNumber }) {
  if (!rowNumber) return null;
  if (!config.publicBaseUrl) {
    logger.warn(`Skipping invoice link for Confirmed_Orders row ${rowNumber} — PUBLIC_BASE_URL is not set in .env.`);
    return null;
  }
  try {
    // The sheet cell itself now uses a ROW()-based formula (see
    // attachInvoiceLinks) so it stays correct even if rows shift later —
    // this url is a point-in-time snapshot for THIS call only (e.g. to text
    // to a customer right now), not what actually ends up in the cell.
    const url = `${config.publicBaseUrl}/invoice/${rowNumber}?token=${config.invoiceViewToken}`;
    const wrote = await googleSheets.attachInvoiceLinks(rowNumber);
    if (!wrote) {
      logger.warn(`Invoice link NOT attached for Confirmed_Orders row ${rowNumber} — Google Sheets is not enabled/initialized.`);
      return null;
    }
    logger.success(`Invoice link attached for Confirmed_Orders row ${rowNumber}.`);
    return { url };
  } catch (err) {
    logger.error(`Attaching invoice link failed for Confirmed_Orders row ${rowNumber} (the order row itself is unaffected).`, err);
    return null;
  }
}

module.exports = { generateAndAttachInvoice };
