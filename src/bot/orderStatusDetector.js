const { containsAny } = require('../utils/helpers');

// Deterministic, same reasoning as escalationDetector.js/orderConfirmationReplyDetector.js:
// whether the bot answers from live Sheet data (vs guessing/half-remembering
// from conversation history) must not depend on the LLM correctly reading
// intent every time — a wrong guess here means a customer gets told
// something false about their own order. Phrases cover the common ways a
// customer asks "where's my order" / "has it shipped" / "when will it
// arrive" without needing an exact keyword match (containsAny already
// normalizes alef/ya/ta-marbuta variants and diacritics — see helpers.js).
const ORDER_STATUS_PHRASES = [
  'فين طلبي',
  'فين الطلب',
  'فين اوردري',
  'فين الاوردر',
  'فين شحنتي',
  'فين الشحنة',
  // 2026-08-10 additions — confirmed live: a real customer's "ممكن اعرف
  // طلبى فين دلوقتي" ("can I know where my order is now") went unmatched
  // because it puts the noun BEFORE "فين" ("order where"), the reverse of
  // every phrase above ("فين طلبي" = "where order"). Both orderings are
  // natural Egyptian Arabic word order, so both need covering. Missing this
  // let the message fall through to the general LLM path instead of this
  // deterministic short-circuit, and the LLM incorrectly completed a stale,
  // long-abandoned product recommendation as a brand-new confirmed order
  // (see llmAgent.js's applyValidatedOutput — order_data.confirmed trusted
  // the model even though nothing in this turn was actually about
  // confirming a purchase).
  'طلبي فين',
  'الطلب فين',
  'اوردري فين',
  'الاوردر فين',
  'شحنتي فين',
  'الشحنة فين',
  'وصل طلبي',
  'وصل الطلب',
  'وصل اوردري',
  'وصل الاوردر',
  'الشحنة وصلت',
  'وصلت لفين',
  'طلبي وصل',
  'اوردري وصل',
  'حالة طلبي',
  'حالة الطلب',
  'حالة اوردري',
  'متابعة الطلب',
  'متابعة طلبي',
  'تتبع الطلب',
  'تتبع طلبي',
  'امتى هيوصل',
  'امتى هوصل',
  'امتى الطلب هيوصل',
  'امتى الاوردر هيوصل',
  'امتى يوصل',
  'طلبي هيوصل امتى',
];

function isOrderStatusInquiry(text) {
  return containsAny(text, ORDER_STATUS_PHRASES);
}

module.exports = { isOrderStatusInquiry };
