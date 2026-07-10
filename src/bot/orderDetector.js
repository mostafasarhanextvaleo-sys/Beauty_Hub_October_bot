const { containsAny, containsWord } = require('../utils/helpers');
const {
  ORDER_CONFIRM_KEYWORDS,
  ORDER_CANCEL_KEYWORDS,
  ADDRESS_CONFIRM_YES_KEYWORDS,
  ADDRESS_CONFIRM_NO_KEYWORDS,
  SHORT_YES_WORDS,
  SHORT_NO_WORDS,
} = require('./prompts');

const INTENT = {
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  UNDECIDED: 'UNDECIDED',
};

function detectIntent(text) {
  if (containsAny(text, ORDER_CANCEL_KEYWORDS) || containsWord(text, SHORT_NO_WORDS)) {
    return INTENT.CANCELLED;
  }
  if (containsAny(text, ORDER_CONFIRM_KEYWORDS) || containsWord(text, SHORT_YES_WORDS)) {
    return INTENT.CONFIRMED;
  }
  return INTENT.UNDECIDED;
}

// Separate from detectIntent(): used only at the "is this order/address data
// correct?" step, with its own keyword set (e.g. "تمام"/"ايوه" mean yes here,
// but aren't purchase-intent signals earlier in the conversation).
function detectAddressConfirmation(text) {
  if (containsAny(text, ADDRESS_CONFIRM_NO_KEYWORDS) || containsWord(text, SHORT_NO_WORDS)) {
    return INTENT.CANCELLED;
  }
  if (containsAny(text, ADDRESS_CONFIRM_YES_KEYWORDS) || containsWord(text, SHORT_YES_WORDS)) {
    return INTENT.CONFIRMED;
  }
  return INTENT.UNDECIDED;
}

module.exports = {
  INTENT,
  detectIntent,
  detectAddressConfirmation,
};
