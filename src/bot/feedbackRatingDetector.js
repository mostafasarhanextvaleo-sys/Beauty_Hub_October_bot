// Deterministic, no API call — same reasoning as orderConfirmationReplyDetector.js:
// whether a rating gets saved to the Feedback sheet must never depend on the
// LLM correctly reading intent every time. Only consulted by llmAgent.js when
// session.awaitingFeedbackRating is true (orderPipeline.js actually sent the
// delivery+rating-request message for this customer — see
// runOrderDeliveredCheck) — never on ordinary chat.
//
// Looks for a standalone digit 1-5 (ASCII or Arabic-Indic ١-٥) — NOT part of
// a longer digit run, so it doesn't false-match inside a phone number, a
// year, or a price ("15", "2026", "٥٠" for 50 EGP all correctly fail to
// match). Everything else in the message becomes the comment. Deliberately
// operates on the customer's original text (not helpers.js's normalizeArabic
// output) for the comment half, so the saved comment keeps their own
// wording/diacritics rather than a normalized/lowercased version.
const DIGIT_CLASS = '0-9٠-٩۰-۹';
const RATING_TOKEN_PATTERN = new RegExp(`(?<![${DIGIT_CLASS}])([1-5١-٥])(?![${DIGIT_CLASS}])`);
const ARABIC_INDIC_TO_ASCII = { '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5' };

function toRatingNumber(matchedChar) {
  return parseInt(ARABIC_INDIC_TO_ASCII[matchedChar] || matchedChar, 10);
}

// Returns { rating, comment } when a recognizable 1-5 rating is found, or
// null when it isn't (caller falls through to the LLM, flag stays set — see
// llmAgent.js's awaitingFeedbackRating interception).
function parseFeedbackRating(text) {
  if (!text) return null;
  const match = RATING_TOKEN_PATTERN.exec(text);
  if (!match) return null;
  const rating = toRatingNumber(match[0]);
  const comment = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { rating, comment };
}

module.exports = { parseFeedbackRating };
