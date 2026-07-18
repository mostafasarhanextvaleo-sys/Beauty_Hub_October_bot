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
    .replace(/[ً-ْ]/g, '') // strip Arabic diacritics
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
function containsWord(text, keywords) {
  const normalized = normalizeArabic(text);
  const words = normalized.split(' ').filter(Boolean);
  const normalizedKeywords = keywords.map((k) => normalizeArabic(k));
  return words.some((word) => normalizedKeywords.includes(word));
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
  sleep,
  sanitizePhoneNumber,
  truncate,
  nowIsoDate,
  withTimeout,
};
