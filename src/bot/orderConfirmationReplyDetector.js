const { containsAny, containsWord } = require('../utils/helpers');

// Deterministic, no API call — same reasoning as productImageRequestDetector.js
// and the old deliveryFeedbackDetector.js: whether a real Confirmed_Orders
// row flips Pending -> Confirmed/Rejected must never depend on the LLM
// correctly reading intent every time. Only consulted by llmAgent.js when
// session.awaitingOrderConfirmationReply is true (i.e. orderPipeline.js
// actually sent the confirmation-request message for this customer — see
// runOrderConfirmationRequestCheck) — never on ordinary chat.
//
// Whole-word match, not containsAny's substring match — "تمام" and "تأكيد"
// are short enough to appear inside unrelated words/phrases. normalizeArabic
// (helpers.js) already collapses أ/إ/آ to ا, so "تأكيد" and the
// hamza-dropped "تاكيد" (common on Arabic keyboards, same reasoning as this
// codebase's جل/جيل spelling-variance handling elsewhere) normalize to the
// identical string and both match from the one "تأكيد" entry below.
const ORDER_CONFIRMATION_REPLY_WORDS = ['تأكيد', 'تمام', 'confirm', 'confirmed'];

// 2026-08-10 addition — llmAgent.js must check rejection BEFORE confirmation:
// containsWord splits on whitespace and matches each token independently, so
// a customer replying "مش تمام" ("not OK") contains the standalone word
// "تمام" and would otherwise false-match ORDER_CONFIRMATION_REPLY_WORDS above.
// Phrases go through containsAny (safe as substrings once they're 2+ words —
// same reasoning as ORDER_CANCELLATION_REQUEST_KEYWORDS in prompts.js);
// short single words that could false-match inside unrelated words go
// through containsWord instead (same reasoning as SHORT_NO_WORDS).
const ORDER_REJECTION_REPLY_PHRASES = [
  'مش موافق',
  'مش موافقة',
  'مش عايز الطلب',
  'مش عايزة الطلب',
  'الغاء الطلب',
  'الغي الطلب',
  'مش تمام',
  'مش هاخد الطلب',
  'مش هاخده الطلب',
  'كنسل الطلب',
  'كنسل الاوردر',
];
const ORDER_REJECTION_REPLY_WORDS = ['رفض', 'رفضت', 'لا', 'لأ', 'reject', 'rejected', 'cancel'];

function isOrderConfirmationReply(text) {
  return containsWord(text, ORDER_CONFIRMATION_REPLY_WORDS);
}

function isOrderRejectionReply(text) {
  return containsAny(text, ORDER_REJECTION_REPLY_PHRASES) || containsWord(text, ORDER_REJECTION_REPLY_WORDS);
}

module.exports = { isOrderConfirmationReply, isOrderRejectionReply };
