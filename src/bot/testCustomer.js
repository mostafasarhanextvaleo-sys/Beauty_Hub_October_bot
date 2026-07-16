// Formerly shared between scripts/testRunner.js (writes this session) and
// scripts/chatEvaluator.js (reads it) — both retired 2026-07-16, testRunner.js
// deleted outright and chatEvaluator.js stopped/removed from PM2. Left here
// since adminCommands.js still checks the literal "TEST_CUSTOMER" string when
// labeling pending corrections. The "@test.local" suffix is deliberately not
// a valid WhatsApp JID shape, so it can never collide with a real customer
// chatId.
const TEST_CUSTOMER_CHAT_ID = 'TEST_CUSTOMER@test.local';
const TEST_CUSTOMER_PHONE = 'TEST_CUSTOMER';

module.exports = { TEST_CUSTOMER_CHAT_ID, TEST_CUSTOMER_PHONE };
