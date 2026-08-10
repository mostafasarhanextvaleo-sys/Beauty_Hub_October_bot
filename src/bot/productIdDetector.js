const { normalizeArabic } = require('../utils/helpers');

// Pure text extraction only — never resolves against the real catalog itself
// (that's productMatcher.js's findByIdCandidate, called from llmAgent.js).
// Same separation of concerns as every other *Detector.js in this codebase:
// detectors decide "does this look like an X", resolution against real data
// happens where the catalog is loaded.

// Matches a real catalog SKU shape directly — e.g. "C102", "c-102", "C 102"
// (this store's live catalog uses a letter prefix + digits, see
// googleSheetsProducts.js). This shape barely occurs in ordinary Arabic/
// English prose — a size ("100 مل") or spec ("SPF 50") never sticks LATIN
// letters directly onto a number this way — so no extra context is required
// for it. Final safety net either way: findByIdCandidate only ever returns a
// product on an EXACT match, so a token that happens to look SKU-shaped but
// isn't a real id (e.g. an incidental "AB12") is silently dropped, never
// guessed at.
const SKU_TOKEN_REGEX = /\b[a-z]{1,4}[\s-]?\d{1,6}\b/g;

// Bare numbers are only ever treated as a possible product id when one of
// these markers is right there in the same message — deliberately NOT bare
// "رقم" alone. Reason: "رقم" is also exactly the word customers use to pick
// an item off a numbered list Sara herself just showed them (e.g. "رقم ٣" —
// see llmAgent.js's session.shownProductIds / the 2026-08-09 mispin history
// this codebase already had to fix once). Requiring "منتج"/"كود"/"SKU"/"ID"/
// "#" alongside the number is what keeps that completely different, far more
// common phrasing from ever being misread as a catalog SKU lookup.
const EXPLICIT_ID_PATTERNS = [
  /(?:كود|sku|id)\s*[:#-]?\s*(\d{1,6})/,
  /(?:منتج|المنتج)\s+رقم\s*[:#-]?\s*(\d{1,6})/,
  /رقم\s+(?:المنتج|كود)\s*[:#-]?\s*(\d{1,6})/,
  /#\s*(\d{1,6})/,
];

function extractProductIdCandidates(text) {
  if (!text) return [];
  const normalized = normalizeArabic(text);
  const candidates = new Set();

  const skuMatches = normalized.match(SKU_TOKEN_REGEX) || [];
  skuMatches.forEach((m) => candidates.add(m.replace(/[\s-]/g, '').toUpperCase()));

  EXPLICIT_ID_PATTERNS.forEach((pattern) => {
    const match = normalized.match(pattern);
    if (match && match[1]) candidates.add(match[1]);
  });

  return [...candidates];
}

module.exports = { extractProductIdCandidates };
