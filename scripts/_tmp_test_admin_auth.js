// Verifies the 2026-08-04 Dynamic Admin Privilege Escalation state machine
// (src/bot/adminAuth.js): 3x "admin" to activate, 3x "user" to deactivate,
// counter resets on any interrupting message, and 1h expiry.
const assert = require('assert');
const conversationMemory = require('../src/bot/conversationMemory');
const adminAuth = require('../src/bot/adminAuth');

const CHAT_ID = 'admin_auth_test@c.us';

function cleanup() {
  conversationMemory.resetSession(CHAT_ID);
}

(function testActivation() {
  cleanup();
  let r = adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  assert.strictEqual(r.consumed, true);
  assert.ok(r.reply.includes('1/3'));
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, undefined, 'must not be active yet after 1st');

  r = adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  assert.ok(r.reply.includes('2/3'));
  assert.ok(!conversationMemory.getSession(CHAT_ID).adminMode, 'must not be active yet after 2nd');

  r = adminAuth.processAdminModeMessage(CHAT_ID, 'ADMIN'); // case-insensitive
  assert.strictEqual(r.consumed, true);
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, true, 'must be active after the 3rd');
  assert.ok(conversationMemory.getSession(CHAT_ID).adminModeExpiresAt > Date.now(), 'expiry must be set in the future');
  console.log('PASS: 3 consecutive "admin" messages activate Admin Mode.');
})();

(function testCounterResetsOnInterruption() {
  cleanup();
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'hello, not admin');
  const r = adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  assert.ok(r.reply.includes('1/3'), 'expected the counter to have reset to 1, not continued to 2, after an interrupting message');
  assert.ok(!conversationMemory.getSession(CHAT_ID).adminMode);
  console.log('PASS: an interrupting non-"admin" message resets the activation counter.');
})();

(function testOrdinaryMessageFallsThrough() {
  cleanup();
  const r = adminAuth.processAdminModeMessage(CHAT_ID, 'عايزة اطلب منتج');
  assert.strictEqual(r.consumed, false);
  assert.strictEqual(r.isAdminCommand, false, 'expected an ordinary message to fall through to the normal customer flow');
  console.log('PASS: an ordinary message (not in Admin Mode) falls through as a normal customer message.');
})();

(function testAdminCommandRoutingWhileActive() {
  cleanup();
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  const r = adminAuth.processAdminModeMessage(CHAT_ID, 'وقف البوت');
  assert.strictEqual(r.consumed, false);
  assert.strictEqual(r.isAdminCommand, true, 'expected a real command while in Admin Mode to be routed to the admin command handler');
  console.log('PASS: a real command while in Admin Mode is routed to the admin command handler, not consumed by the ritual.');
})();

(function testDeactivation() {
  cleanup();
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, true);

  let r = adminAuth.processAdminModeMessage(CHAT_ID, 'user');
  assert.ok(r.reply.includes('1/3'));
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, true, 'must still be active after 1st "user"');

  r = adminAuth.processAdminModeMessage(CHAT_ID, 'user');
  assert.ok(r.reply.includes('2/3'));
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, true, 'must still be active after 2nd "user"');

  r = adminAuth.processAdminModeMessage(CHAT_ID, 'user');
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, false, 'must be deactivated after the 3rd "user"');
  console.log('PASS: 3 consecutive "user" messages while in Admin Mode deactivate it.');
})();

(function testDeactivationCounterResetsOnRealCommand() {
  cleanup();
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'user'); // 1/3
  adminAuth.processAdminModeMessage(CHAT_ID, 'وقف البوت'); // real command, interrupts the count
  const r = adminAuth.processAdminModeMessage(CHAT_ID, 'user');
  assert.ok(r.reply.includes('1/3'), 'expected the deactivation counter to have reset after a real command in between');
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, true, 'must still be active — only 1 fresh "user" so far');
  console.log('PASS: an interrupting real command resets the deactivation counter.');
})();

(function testExpiry() {
  cleanup();
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  adminAuth.processAdminModeMessage(CHAT_ID, 'admin');
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, true);

  // Force expiry.
  conversationMemory.updateSession(CHAT_ID, { adminModeExpiresAt: Date.now() - 1000 });

  const r = adminAuth.processAdminModeMessage(CHAT_ID, 'وقف البوت');
  assert.strictEqual(r.consumed, true, 'expected the expiry to consume this turn with its own notice');
  assert.ok(r.reply.includes('انتهت'));
  assert.strictEqual(conversationMemory.getSession(CHAT_ID).adminMode, false, 'expected adminMode to be cleared');

  // The customer's real message must be re-sent — this turn was just the
  // expiry notice, not routed as a command nor as an ordinary message.
  const followUp = adminAuth.processAdminModeMessage(CHAT_ID, 'وقف البوت');
  assert.strictEqual(followUp.isAdminCommand, false, 'expected the same message re-sent after expiry to now be treated as an ordinary customer message');
  console.log('PASS: Admin Mode expires after its duration, with a clear notice, and reverts to normal user mode.');
})();

cleanup();
console.log('\nALL ADMIN AUTH TESTS PASSED');
