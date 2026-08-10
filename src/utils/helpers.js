// Arabic-Indic (٠-٩) and Extended Arabic-Indic/Persian (۰-۹) digits, mapped
// to plain ASCII so every existing \d/\D-based regex in the codebase
// (PHONE_LIKE, price-digit stripping in llmAgent.js's validateModelOutput,
// etc.) keeps working unchanged instead of silently treating them as
// non-digits — 2026-07-18 audit: verified '١٦٠'.replace(/\D/g,'') produced
// an empty string, and PHONE_LIKE failed to match an otherwise-valid
// Arabic-Indic phone number, before this fix.
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_ARABIC_INDIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function normalizeArabic(text) {
  if (!text) return '';
  return text
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[أإآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ـ/g, '') // strip tatweel/kashida (stylistic elongation, e.g. "حبـــوب")
    .replace(/[ً-ْ]/g, '') // strip Arabic diacritics
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(EXTENDED_ARABIC_INDIC_DIGITS.indexOf(d)))
    .replace(/\s+/g, ' ');
}

function containsAny(text, keywords) {
  const normalized = normalizeArabic(text);
  return keywords.some((keyword) => normalized.includes(normalizeArabic(keyword)));
}

// Like containsAny, but requires an exact whole-word match rather than a
// substring. Needed for very short keywords (e.g. "لا", "صح") that would
// otherwise false-match inside unrelated words (e.g. "لا" is a substring of
// "الاسم" — a customer typing "الاسم مصطفى..." must not be read as "no").
// 2026-08-09 fix: trailing/leading punctuation used to defeat this entirely —
// confirmed live, "عندك صور؟" failed to match "صور" because the actual token
// was "صور؟" (with the Arabic question mark still attached), not "صور". This
// is strictly more permissive than before (can only turn a previous false
// negative into a correct match, never the reverse), so it's a safe fix for
// every existing caller (order confirm/cancel short words, delivery-feedback
// yes/no, SPECIALIST_REFERRAL medical terms), not just the one that surfaced it.
const WORD_PUNCTUATION_PATTERN = /^[؟!.,،؛:"'\-]+|[؟!.,،؛:"'\-]+$/g;

function containsWord(text, keywords) {
  const normalized = normalizeArabic(text);
  const words = normalized
    .split(' ')
    .map((w) => w.replace(WORD_PUNCTUATION_PATTERN, ''))
    .filter(Boolean);
  const normalizedKeywords = keywords.map((k) => normalizeArabic(k));
  return words.some((word) => normalizedKeywords.includes(word));
}

// 2026-08-09 fix — found while investigating a real customer's wrong shipping
// fee: containsAny's plain substring check let short single-word zone
// keywords in shippingZones.js false-match INSIDE unrelated real place
// names — confirmed live, "قنا" (Qena, Upper Egypt) matched as a substring
// of "القناطر" (Al Qanater, a Qalyubia/Delta town, part of "شبين القناطر"),
// and "بدر" (Badr) matched inside "بدرشين" (Badrashin, a Giza town) — both
// silently assigned the wrong, more expensive shipping tier. containsWord
// above only solves this for single-word keywords (it requires the whole
// INPUT token to equal a keyword), but several real zone keywords are
// multi-word phrases (e.g. "شبرا الخيمة", "6 اكتوبر") that would never equal
// a single word. This checks each keyword's own words as a contiguous
// whole-word subsequence of the text's words instead — correct for both a
// single-word keyword (now whole-word, no more substring collisions) and a
// multi-word phrase (still matched as consecutive real words, not a raw
// substring of the whole string).
function containsWordSequence(text, keywords) {
  const normalized = normalizeArabic(text);
  const textWords = normalized
    .split(' ')
    .map((w) => w.replace(WORD_PUNCTUATION_PATTERN, ''))
    .filter(Boolean);
  return keywords.some((keyword) => {
    const keywordWords = normalizeArabic(keyword)
      .split(' ')
      .map((w) => w.replace(WORD_PUNCTUATION_PATTERN, ''))
      .filter(Boolean);
    if (keywordWords.length === 0) return false;
    for (let i = 0; i <= textWords.length - keywordWords.length; i += 1) {
      if (keywordWords.every((kw, j) => textWords[i + j] === kw)) return true;
    }
    return false;
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePhoneNumber(whatsappId) {
  if (!whatsappId) return '';
  return whatsappId.split('@')[0];
}

function truncate(text, maxLength = 300) {
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function nowIsoDate() {
  return new Date().toISOString();
}

// Shared timeout-race helper — previously duplicated separately in
// geminiService.js/localService.js/adminCommands.js/tagProductsSkinType.js.
// Hoisted here (2026-07-18 audit) so openaiService.js/embeddingService.js —
// the two hot-path services that had NO timeout at all despite being the
// tiers actually live in production — can reuse the exact same mechanism
// instead of a fifth copy. Rejects with a labeled error after `ms`; callers
// already treat any rejection as "this tier failed, try the next one."
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = {
  normalizeArabic,
  containsAny,
  containsWord,
  containsWordSequence,
  sleep,
  sanitizePhoneNumber,
  truncate,
  nowIsoDate,
  withTimeout,
};
