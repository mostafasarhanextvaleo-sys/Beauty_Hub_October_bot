const { containsAny } = require('../utils/helpers');

// Deterministic, same reasoning as escalationDetector.js/deliveryFeedbackDetector.js:
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
