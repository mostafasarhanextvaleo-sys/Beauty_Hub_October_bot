// Regression check (not committed) for the 2026-08-09 order-management
// pipeline: orderConfirmationReplyDetector.js and feedbackRatingDetector.js.
// Pure deterministic functions, no stubbing needed.
const assert = require('assert');
const { isOrderConfirmationReply } = require('../src/bot/orderConfirmationReplyDetector');
const { parseFeedbackRating } = require('../src/bot/feedbackRatingDetector');

// --- orderConfirmationReplyDetector ---
assert.strictEqual(isOrderConfirmationReply('تأكيد'), true, 'exact تأكيد should match');
assert.strictEqual(isOrderConfirmationReply('تاكيد'), true, 'hamza-dropped تاكيد should match (normalizeArabic collapses أ->ا)');
assert.strictEqual(isOrderConfirmationReply('تمام'), true, 'exact تمام should match');
assert.strictEqual(isOrderConfirmationReply('Confirm'), true, 'English Confirm should match');
assert.strictEqual(isOrderConfirmationReply('confirmed'), true, 'English confirmed should match');
assert.strictEqual(isOrderConfirmationReply('تمام كده بس هستناكم بكرة'), true, 'تمام as a real standalone word inside a longer sentence should still match');
assert.strictEqual(isOrderConfirmationReply('لا مش دلوقتي'), false, 'a real non-confirmation reply must not match');
assert.strictEqual(isOrderConfirmationReply('عايزة الغي الاوردر'), false, 'a cancellation request must not be misread as a confirmation');
assert.strictEqual(isOrderConfirmationReply(''), false, 'empty text must not match');
console.log('PASS: orderConfirmationReplyDetector — matches/non-matches all correct.');

// --- feedbackRatingDetector ---
assert.deepStrictEqual(parseFeedbackRating('5 ممتاز جدا'), { rating: 5, comment: 'ممتاز جدا' }, 'leading digit + comment');
assert.deepStrictEqual(parseFeedbackRating('التقييم تلاته... مش قصدي 3'), { rating: 3, comment: 'التقييم تلاته... مش قصدي' }, 'digit embedded mid-sentence, spelled-out number ignored');
assert.deepStrictEqual(parseFeedbackRating('٤ حلو اوي'), { rating: 4, comment: 'حلو اوي' }, 'Arabic-Indic digit');
assert.strictEqual(parseFeedbackRating('كويس'), null, 'no digit at all -> null');
assert.strictEqual(parseFeedbackRating('رقمي 01012345678'), null, 'a phone number must not be misread as a rating');
assert.strictEqual(parseFeedbackRating('2026 حلو'), null, 'a year must not be misread as a rating');
assert.strictEqual(parseFeedbackRating('15 دقيقة بس وصل'), null, 'a two-digit number (15) must not be misread as rating 1 or 5');
assert.strictEqual(parseFeedbackRating('0 زفت'), null, 'out-of-range digit 0 (no other digit present) -> null');
// Known, acceptable edge case: an out-of-range digit (6-9) is simply not in
// the match class, so the regex keeps scanning and can still find a real
// in-range digit elsewhere in the same message. Not realistic customer
// phrasing ("6 out of 5") — documented here so it's a deliberate, understood
// limitation rather than a silent surprise.
assert.deepStrictEqual(parseFeedbackRating('6 من 5'), { rating: 5, comment: '6 من' }, 'an out-of-range 6 is skipped; the real in-range 5 later in the message is still found');
assert.strictEqual(parseFeedbackRating(''), null, 'empty text -> null');
console.log('PASS: feedbackRatingDetector — rating extraction correct on all real and edge cases.');

console.log('ALL PASS: order-pipeline detectors.');
