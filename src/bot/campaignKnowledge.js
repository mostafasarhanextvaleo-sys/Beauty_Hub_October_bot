const logger = require('../utils/logger');
const googleSheets = require('../services/googleSheets');
const productMatcher = require('./productMatcher');

// Keeps the LLM aware of whatever campaigns are actually live in
// Offers_Campaign (2026-08-02) — previously OFFER_TEXT only ever reached the
// outbound campaign blast (campaignWorker.js), so a customer who asked about
// a running offer mid-chat instead of receiving the blast got no real
// answer. Same refresh pattern as productMatcher.js: polled on a timer
// rather than read per-message, since the whole point is every simultaneous
// customer sees the same, cheap-to-reuse snapshot rather than a Sheets call
// per turn.
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let activeOffers = []; // [{offerId, offerName, offerText}, ...] — PUSH rows only
let refreshTimer = null;

// 2026-08-02 audit fix: resolves each offer's Product ID (if set) against the
// live catalog so the offer is grounded in a real, priced SKU rather than
// just free-text marketing copy — see OFFERS_CAMPAIGN_HEADERS' comment in
// googleSheets.js for the concrete failure this fixes (a customer's explicit
// reference to the promoted product went unrecognized because the marketing
// name didn't match any catalog product). `product` is null if the offer has
// no Product ID set, or if it's set but doesn't resolve to a real product —
// either way the offer still sends fine, this is additive grounding only.
async function refresh() {
  try {
    const rows = await googleSheets.getOffersCampaignRows();
    activeOffers = rows
      .filter((r) => r.campaignStatus === 'PUSH' && r.offerText.trim())
      .map((r) => {
        const product = r.productId ? productMatcher.getById(r.productId) : null;
        if (r.productId && !product) {
          logger.warn(`Offers_Campaign row "${r.offerId}" has Product ID "${r.productId}" which doesn't match any catalog product — sending offer text as-is, without grounding.`);
        }
        return { offerId: r.offerId, offerName: r.offerName || r.offerId, offerText: r.offerText.trim(), product };
      });
    logger.info(`Loaded ${activeOffers.length} active campaign offer(s) from Offers_Campaign for the bot's live knowledge.`);
    return true;
  } catch (err) {
    logger.error('Failed to refresh active campaign offers from Offers_Campaign. Keeping the last known list.', err);
    return false;
  }
}

function startAutoRefresh(intervalMs = AUTO_REFRESH_INTERVAL_MS) {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    refresh();
  }, intervalMs);
  if (refreshTimer.unref) refreshTimer.unref();
}

function getActiveOffers() {
  return activeOffers;
}

module.exports = { refresh, startAutoRefresh, getActiveOffers };
