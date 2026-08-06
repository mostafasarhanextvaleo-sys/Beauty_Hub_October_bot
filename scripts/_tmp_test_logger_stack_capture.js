// Repro for why scripts/scheduledReport.js's gatherPm2ErrorStats() only ever
// sees the generic wrapper message for these failures, never the underlying
// exception: it filters pm2's error log to lines matching a leading
// "[ISO timestamp]" bracket (tsRe below, copied verbatim from that script),
// which is exactly logger.js's own line-1 format — but err.stack is written
// as separate, un-bracketed lines, so it's silently dropped by that filter.
const assert = require('assert');
const logger = require('../src/utils/logger');

const tsRe = /\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/;
const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const lines = [];
const origError = console.error;
console.error = (...args) => lines.push(args.join(' '));

const fakeErr = new Error('invalid_grant: reauth related error (invalid_rapt)');
logger.error('Campaign test-trigger check failed.', fakeErr);

console.error = origError;

console.log('Raw lines written to console.error:');
lines.forEach((l, i) => console.log(`  [${i}] ${JSON.stringify(clean(l))}`));

const survivingLines = lines.filter((line) => tsRe.test(clean(line)));
console.log('\nLines that survive gatherPm2ErrorStats\'s timestamp filter:');
survivingLines.forEach((l) => console.log(`  -> ${clean(l)}`));

const anySurvivingLineMentionsTheRealError = survivingLines.some((l) => clean(l).includes('invalid_grant'));
console.log(`\nDoes any surviving line mention the real error ("invalid_grant")? ${anySurvivingLineMentionsTheRealError}`);
assert.strictEqual(
  anySurvivingLineMentionsTheRealError,
  true,
  'BUG CONFIRMED: the underlying exception never survives into what the scheduled report samples — only the generic wrapper message does.'
);
console.log('PASS: underlying exception detail now survives the timestamp-line filter.');
