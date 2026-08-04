// 2026-08-04 — Dynamic Admin Privilege Escalation (store owner directive).
//
// Before this, ANY message from the configured admin number was ALWAYS
// instantly routed to the full admin command channel (pause the bot,
// approve/reject corrections, broadcasts) — unconditional, no timeout, and
// with no way for the admin's own phone to experience the bot as a normal
// customer would. This replaces that: the admin number is a completely
// standard Sara customer by default. Admin Mode is a per-session state,
// entered by typing the exact word "admin" three separate times in a row
// (any other message in between resets the count to zero), lasts 1 hour,
// and can be exited early the same way with "user" x3. Scoped ONLY to
// whatever phone number(s) config.adminWhatsappNumber names — never
// available to any other customer (see whatsapp/client.js's call site,
// which only ever calls this for that exact phone).
//
// Deliberately deterministic and independent of the LLM/Sara entirely — the
// same "never trust a security-relevant decision to the model's judgment"
// principle already used throughout this codebase (escalationDetector.js,
// the SPECIALIST_REFERRAL verification in llmAgent.js, etc.).
const { getSession, updateSession } = require('./conversationMemory');

const REQUIRED_CONSECUTIVE_COUNT = 3;
const ADMIN_MODE_DURATION_MS = 60 * 60 * 1000; // 1 hour

const ADMIN_MODE_ACTIVATED_MESSAGE =
  '✅ تم تفعيل وضع الأدمن. هيفضل شغال لمدة ساعة، أو اكتب "user" 3 مرات متتالية للخروج يدويًا قبل كده.';
const ADMIN_MODE_EXITED_MESSAGE = '✅ تم الخروج من وضع الأدمن، رجعت للوضع العادي.';
const ADMIN_MODE_EXPIRED_MESSAGE = '⏱️ انتهت صلاحية وضع الأدمن (مرت ساعة) — رجعت للوضع العادي. ابعت رسالتك تاني لو محتاجة حاجة.';

function buildProgressReply(direction, count) {
  const remaining = REQUIRED_CONSECUTIVE_COUNT - count;
  return direction === 'enter'
    ? `⚙️ تفعيل وضع الأدمن (${count}/${REQUIRED_CONSECUTIVE_COUNT}) — اكتب "admin" ${remaining} مرة/مرات كمان للتأكيد.`
    : `⚙️ الخروج من وضع الأدمن (${count}/${REQUIRED_CONSECUTIVE_COUNT}) — اكتب "user" ${remaining} مرة/مرات كمان للتأكيد.`;
}

// Called only for messages from the configured admin phone number (see
// whatsapp/client.js). Returns:
//   { consumed: true, reply }        — this message was part of the admin-mode
//                                       ritual itself (progress/activation/
//                                       exit/expiry notice); send `reply` and
//                                       do nothing else with this message.
//   { consumed: false, isAdminCommand: true }  — currently in Admin Mode and
//                                       this is a real command; route it to
//                                       the actual admin command handler.
//   { consumed: false, isAdminCommand: false } — not in Admin Mode and this
//                                       wasn't the "admin" keyword; treat this
//                                       phone as a completely ordinary
//                                       customer for this message (fall
//                                       through to the normal Sara flow).
function processAdminModeMessage(chatId, text) {
  const session = getSession(chatId);
  const normalized = (text || '').trim().toLowerCase();

  // Expiry is checked and unconditionally consumes this turn with its own
  // notice — an admin whose hour just ran out shouldn't have their very next
  // message silently misrouted (to Sara if it was meant as a command, or
  // swallowed as a "ritual" message if it happened to be the word "admin"/
  // "user") with no explanation. They just send whatever they meant again
  // right after.
  if (session.adminMode && session.adminModeExpiresAt && Date.now() >= session.adminModeExpiresAt) {
    updateSession(chatId, { adminMode: false, adminModeExpiresAt: null, adminActivationCount: 0, adminDeactivationCount: 0 });
    return { consumed: true, reply: ADMIN_MODE_EXPIRED_MESSAGE };
  }

  if (session.adminMode) {
    if (normalized === 'user') {
      const count = (session.adminDeactivationCount || 0) + 1;
      if (count >= REQUIRED_CONSECUTIVE_COUNT) {
        updateSession(chatId, { adminMode: false, adminModeExpiresAt: null, adminActivationCount: 0, adminDeactivationCount: 0 });
        return { consumed: true, reply: ADMIN_MODE_EXITED_MESSAGE };
      }
      updateSession(chatId, { adminDeactivationCount: count });
      return { consumed: true, reply: buildProgressReply('exit', count) };
    }
    if (session.adminDeactivationCount) updateSession(chatId, { adminDeactivationCount: 0 });
    return { consumed: false, isAdminCommand: true };
  }

  if (normalized === 'admin') {
    const count = (session.adminActivationCount || 0) + 1;
    if (count >= REQUIRED_CONSECUTIVE_COUNT) {
      updateSession(chatId, {
        adminMode: true,
        adminModeExpiresAt: Date.now() + ADMIN_MODE_DURATION_MS,
        adminActivationCount: 0,
        adminDeactivationCount: 0,
      });
      return { consumed: true, reply: ADMIN_MODE_ACTIVATED_MESSAGE };
    }
    updateSession(chatId, { adminActivationCount: count });
    return { consumed: true, reply: buildProgressReply('enter', count) };
  }
  if (session.adminActivationCount) updateSession(chatId, { adminActivationCount: 0 });
  return { consumed: false, isAdminCommand: false };
}

module.exports = { processAdminModeMessage };
