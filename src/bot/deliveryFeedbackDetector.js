const { containsAny, containsWord } = require('../utils/helpers');

// Same reasoning as escalationDetector.js: whether a delivery got confirmed
// or disputed decides a real Sheet write (Completed vs Issue) and whether
// the admin gets paged, so it must not depend on the LLM correctly reading
// intent every time. Only consulted when session.awaitingDeliveryFeedback is
// true (see llmAgent.js) — never runs against ordinary conversation.
//
// Negative is checked first deliberately: a missed complaint (misread as
// "all good") silently closes a real problem as Completed, which is worse
// than a false positive on the negative side (worst case, Sara asks a
// clarifying question she didn't need to).
const NEGATIVE_PHRASES = [
  'مستلمتش',
  'ملوصلش',
  'مش استلمت',
  'لسه ما وصلش',
  'لسه مستلمتش',
  'لسه ملوصلش',
  'مشكلة',
  'فيه مشكلة',
  'مكسور',
  'تالف',
  'معطوب',
  'مش تمام',
  'ناقص',
  'وصل عطلان',
  'وصل مكسور',
  'وصل غلط',
  'حاجة تانية',
];
// Short/ambiguous single words — substring matching would false-positive
// inside unrelated words (see helpers.js's containsWord doc comment), so
// these need an exact whole-word match instead.
const NEGATIVE_WORDS = ['لا', 'لأ'];

const POSITIVE_PHRASES = [
  'استلمت',
  'استلمته',
  'استلمتها',
  'وصلني',
  'وصل تمام',
  'كله تمام',
  'الحمد لله وصل',
  'وصل الأوردر',
];
const POSITIVE_WORDS = ['تمام', 'اه', 'ايوه', 'ايوة', 'أيوه'];

// Returns 'positive', 'negative', or null (ambiguous/unrelated — caller
// should fall through to normal handling rather than guess).
function classifyDeliveryFeedback(text) {
  if (containsAny(text, NEGATIVE_PHRASES) || containsWord(text, NEGATIVE_WORDS)) return 'negative';
  if (containsAny(text, POSITIVE_PHRASES) || containsWord(text, POSITIVE_WORDS)) return 'positive';
  return null;
}

module.exports = { classifyDeliveryFeedback };
