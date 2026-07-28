const logger = require('../utils/logger');
const productMatcher = require('./productMatcher');

// Static cleanser -> moisturizer pairing for the "complete routine" bundle
// upsell (2026-07-14). No real order-volume history exists yet to derive
// genuine best-sellers — checked the Leads sheet directly: zero completed
// orders, and only 3 products mentioned more than once across all leads,
// none of them cleansers. These 10 are instead the cleansers with a REAL,
// currently-live skin-type tag that matches an equally-tagged moisturizer
// already in the catalog (verified against the live Sheet, not the stale
// local products.json snapshot, which had already drifted).
//
// Most entries point to the same moisturizer (734) because that is
// currently the ONLY oily/combination-tagged moisturizer in the catalog —
// not a bug, an honest reflection of today's sparse tagging (only 5
// moisturizers have a Skin Type value at all). This is the direct
// motivation for the Step 4 tagging pass: more tagged moisturizers means
// more variety here without any code change, just a bigger ROUTINE_BUNDLE_MAP.
//
// Product IDs in this Sheet are NOT stable identifiers — they visibly
// drifted during testing (a row that was ID 13 pointed to a completely
// different product days later, and the total product count changed four
// times across a single afternoon of testing). isSaneComplement() below is
// a defensive runtime check: it re-verifies the looked-up product still
// looks like a moisturizer (right category + name keyword) before ever
// offering it, so a drifted ID silently skips the bundle suggestion instead
// of recommending an unrelated product to a customer.
//
// 2026-07-28 audit: re-verified every ID below against the LIVE Sheet
// (queried directly via googleSheetsProducts.fetchProducts, not the local
// products.json snapshot, which lags the Sheet). Findings:
//  - Complement 734 no longer exists at all (confirmed NOT FOUND live) — the
//    live product with the exact former name "XQ moisturizing gel cream,
//    oily/combination" (اكس كيو كريم جل مرطب للبشرة الدهنية والمختلطة) now
//    sits at id 499. Complement 407 has also drifted (now a mascara, live);
//    the "Care & More glycerin cream (dry)" it used to point to is now at
//    id 520 — same name, same dry/combination tag. Both replaced below.
//  - Keys 501 and 508 have themselves drifted off cleansers entirely: 501 is
//    now an XQ Vitamin C serum and 508 is now a bodycare coconut-wax paste
//    (verified live). isSaneComplement only guards the COMPLEMENT side of a
//    lookup, not the KEY — so leaving these two in place, even repointed at
//    a valid moisturizer, would have silently offered a "complete your
//    routine" face-moisturizer bundle to someone shown a body-wax product or
//    a serum. Removed rather than repointed, since there's no live cleanser
//    currently occupying either ID to legitimately re-map to.
const BUNDLE_DISCOUNT_PERCENT = 10;

const ROUTINE_BUNDLE_MAP = {
  1: '499', // Dermatique Purifying Cleansing Gel (oily/combination) -> XQ moisturizing gel cream (oily/combination)
  2: '499', // NanoTreat Oily Skin Cleanser -> XQ moisturizing gel cream
  3: '499', // O-Clear Cleanser by Hayat (oily) -> XQ moisturizing gel cream
  7: '499', // Collagra Gel Cleanser 100ml (oily) -> XQ moisturizing gel cream
  11: '499', // La Roche-Posay Effaclar Cleansing Gel (oily) -> XQ moisturizing gel cream
  12: '499', // Bioderma Sebium Cleanser (oily/combination) -> XQ moisturizing gel cream
  15: '499', // Moist-1 Cleanser for Sensitive Oily Skin -> XQ moisturizing gel cream
  16: '520', // Moist-1 Cleanser for Normal/Sensitive/Dry Skin (dry/sensitive) -> Care & More glycerin cream (dry)
};

function isSaneComplement(product) {
  if (!product) return false;
  if (product.category !== 'skincare') return false;
  return /مرطب|كريم/.test(product.name || '');
}

// Returns the complementary product for a bundle suggestion, or null if
// there isn't a mapping or the mapping has gone stale (see isSaneComplement
// above) — callers should treat null as "no bundle to offer this turn",
// never as an error to surface to the customer.
function getBundleComplement(productId) {
  const complementId = ROUTINE_BUNDLE_MAP[productId];
  if (!complementId) return null;

  const product = productMatcher.getById(complementId);
  if (!isSaneComplement(product)) {
    if (!product) {
      logger.warn(
        `Routine bundle mapping for product ${productId} points to complement ${complementId}, which no longer exists in the catalog — skipping bundle suggestion. The Sheet's IDs may have shifted; this mapping likely needs updating.`
      );
    } else {
      logger.warn(
        `Routine bundle complement ${complementId} for product ${productId} no longer looks like a moisturizer ("${product.name}", category ${product.category}) — the Sheet's IDs may have shifted. Skipping bundle suggestion.`
      );
    }
    return null;
  }
  return product;
}

module.exports = { getBundleComplement, BUNDLE_DISCOUNT_PERCENT };
