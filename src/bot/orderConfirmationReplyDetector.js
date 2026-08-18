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

// 2026-08-19 audit fix — confirmed real failure shape: a customer replying
// "تمام كده، بس مش هطلب دلوقتي" (fine, but I don't want to order right now)
// contains the standalone word "تمام" and no ADJACENT "مش تمام" substring (the
// negation and the confirmation word are in different clauses), so neither
// ORDER_REJECTION_REPLY_PHRASES nor ORDER_REJECTION_REPLY_WORDS matched it —
// isOrderConfirmationReply's bare word-match on "تمام" alone read this as a
// real confirmation, and the caller (llmAgent.js) flipped a real
// Confirmed_Orders row to 'Confirmed' for a customer who had just declined.
// Rather than trying to enumerate every possible phrase ordering ("مش
// هطلب", "مش عايزة اطلب", "لسه مش متأكدة"...), a genuine order confirmation
// essentially never shares a message with a negation word at all — so a
// confirmation word is only trusted when no negation word appears anywhere
// else in the same message. Deliberately NOT added to
// ORDER_REJECTION_REPLY_WORDS itself: that list drives isOrderRejectionReply,
// which actively sets the row to 'Rejected' — "مش" alone is far too common in
// unrelated Egyptian-Arabic replies (e.g. "مش عارفة العنوان بالظبط") to treat
// as an affirmative rejection signal. Here it only WITHHOLDS a false
// confirmation, falling through to the normal LLM flow (which asks the
// customer to clarify) rather than mis-resolving the order either way.
const CONFIRMATION_NEGATION_WORDS = ['مش', 'لا', 'لأ', 'مو'];

function isOrderConfirmationReply(text) {
  if (!containsWord(text, ORDER_CONFIRMATION_REPLY_WORDS)) return false;
  if (containsWord(text, CONFIRMATION_NEGATION_WORDS)) return false;
  return true;
}

function isOrderRejectionReply(text) {
  return containsAny(text, ORDER_REJECTION_REPLY_PHRASES) || containsWord(text, ORDER_REJECTION_REPLY_WORDS);
}

module.exports = { isOrderConfirmationReply, isOrderRejectionReply };
