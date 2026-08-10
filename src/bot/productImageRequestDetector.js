const { containsAny, containsWord } = require('../utils/helpers');

// A customer explicitly asking to SEE a product photo — deterministic, no API
// call, same reasoning as escalationDetector.js/orderStatusDetector.js: which
// image (if any) gets sent must never depend on the LLM deciding to trigger
// it, since the outgoing image is strictly sheet-driven (Products!Image URL)
// and must never be skipped, guessed, or substituted. See llmAgent.js's
// handleProductImageRequest for what happens once this matches.
// Note: "صورة" (photo/picture) alone, not the bare root "صور" — "صور" is
// also a substring of common unrelated verbs (تتصور/يتصور, "imagine"), which
// would false-positive on things like "متتصوريش إنه غالي". "صورة" (with the
// tied-up ة) doesn't have that collision and already covers the overwhelming
// majority of real phrasings on its own; the rest below are the other
// natural ways customers ask without using that exact word.
const PRODUCT_IMAGE_REQUEST_KEYWORDS = [
  'صورة',
  'صور المنتج',
  'ورينى',
  'وريني',
  'وريها',
  'وريهالي',
  'اشوف شكله',
  'اشوف شكلها',
  'شكل المنتج',
  'شكله ايه',
  'شكلها ايه',
  'picture',
  'photo',
  'product image',
  'image of the product',
];

// 2026-08-09 addition — confirmed live: "ممكن صور الصن بلوك إلى عندك" (bare
// plural "صور", no ة) fell through this detector entirely (the substring list
// above only has "صورة") and landed in general consultation, which then
// hallucinated "مفيش صور متاحة للمنتجات" despite real cached photos existing.
// Whole-word match (not containsAny's substring match) so "صور" as its own
// word is caught without reopening the تصور/يتصور ("imagine") collision the
// header comment above already ruled out for a substring match.
const PRODUCT_IMAGE_REQUEST_WHOLE_WORDS = ['صور', 'صورة'];

function isProductImageRequest(text) {
  return containsAny(text, PRODUCT_IMAGE_REQUEST_KEYWORDS) || containsWord(text, PRODUCT_IMAGE_REQUEST_WHOLE_WORDS);
}

module.exports = { isProductImageRequest };
