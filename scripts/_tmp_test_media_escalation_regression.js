// Regression check (not committed) for the 2026-08-09 P0 fix: repeated
// unreadable media (photo/video/voice note) in a row used to get the
// byte-identical "can't see this" reply forever — confirmed live, one
// customer sent 7 photos + 2 videos in one conversation and got the same
// sentence every time. Verifies prompts.js's getMediaNoCaptionReply degrades
// by consecutive-count: 1st = normal ack+prompt, 2nd = ack + proactive
// catalog-link offer, 3rd+ (MEDIA_ESCALATION_THRESHOLD) = human handoff reply
// instead of repeating anything. Pure function, no stubbing needed — the
// session-counter wiring itself lives in whatsapp/client.js (verified by
// code review, not unit-testable without a full whatsapp-web.js mock).
const assert = require('assert');
const { getMediaNoCaptionReply, MEDIA_ESCALATION_THRESHOLD } = require('../src/bot/prompts');
const { WEBSITE_URL } = require('../src/bot/llmSystemPrompt');

// --- 1. 1st consecutive miss: normal ack + describe prompt, no link, no escalation ---
{
  const reply = getMediaNoCaptionReply('image', 1);
  assert.ok(reply.includes('استلمت الصورة'), 'expected the normal image ack');
  assert.ok(reply.includes('توصفيلي المشكلة'), 'expected the normal describe-your-need prompt');
  assert.ok(!reply.includes(WEBSITE_URL), 'expected no catalog link yet on the 1st miss');
  console.log('PASS: 1st consecutive miss gets the normal ack+prompt only.');
}

// --- 2. 2nd consecutive miss: ack + proactive catalog link, not a repeat of the 1st ---
{
  const first = getMediaNoCaptionReply('image', 1);
  const second = getMediaNoCaptionReply('image', 2);
  assert.notStrictEqual(second, first, 'expected the 2nd miss to differ from the 1st instead of repeating it');
  assert.ok(second.includes(WEBSITE_URL), 'expected the 2nd miss to proactively offer the catalog link');
  console.log('PASS: 2nd consecutive miss offers the catalog link instead of repeating the 1st reply.');
}

// --- 3. Escalation threshold: consecutive count reaching MEDIA_ESCALATION_THRESHOLD stops repeating anything and hands off ---
{
  assert.strictEqual(MEDIA_ESCALATION_THRESHOLD, 3, 'sanity check on the constant this test is written against');
  const third = getMediaNoCaptionReply('video', 3);
  const fourth = getMediaNoCaptionReply('image', 4);
  assert.ok(third.includes('فريقنا'), 'expected a human-handoff reply once the threshold is reached');
  assert.ok(!third.includes(WEBSITE_URL), 'expected the escalation reply to be its own message, not another link offer');
  assert.strictEqual(fourth, third, 'expected every miss past the threshold to keep returning the same stable handoff reply (not loop back to the ack)');
  console.log('PASS: reaching the escalation threshold hands off to a human and stays there for further misses.');
}

// --- 4. Different media types still get type-correct acks below the threshold ---
{
  const videoReply = getMediaNoCaptionReply('video', 1);
  const pttReply = getMediaNoCaptionReply('ptt', 1);
  assert.ok(videoReply.includes('استلمت الفيديو'), 'expected the video-specific ack');
  assert.ok(pttReply.includes('رسالتك الصوتية'), 'expected the voice-note-specific ack');
  console.log('PASS: media-type-specific acknowledgments are preserved below the escalation threshold.');
}

console.log('\nALL MEDIA ESCALATION TESTS PASSED');
process.exit(0);
