const { containsAny } = require('../utils/helpers');

// A customer explicitly asking for a human — must be checked before FAQ/yes-
// no detection at every stage that has one, so a request for help never gets
// silently swallowed as if it were address text or an unrecognized answer.
const ESCALATION_KEYWORDS = [
  'اكلم حد',
  'اتكلم مع حد',
  'خدمة العملاء',
  'خدمه العملاء',
  'حد يرد عليا',
  'عايز اتكلم مع حد',
  'عايزة اتكلم مع حد',
  'مسؤول',
  'موظف',
  'انسان',
  'مش بوت',
  'مش عايز اتكلم مع بوت',
];

function isEscalationRequest(text) {
  return containsAny(text, ESCALATION_KEYWORDS);
}

module.exports = { isEscalationRequest };
