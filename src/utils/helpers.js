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

module.exports = {
  normalizeArabic,
  containsAny,
  containsWord,
  sleep,
  sanitizePhoneNumber,
  truncate,
  nowIsoDate,
};
