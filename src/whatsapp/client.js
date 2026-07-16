const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const logger = require('../utils/logger');
const agent = require('../bot/agent');
const googleSheets = require('../services/googleSheets');
const { sanitizePhoneNumber, truncate, normalizeArabic, sleep } = require('../utils/helpers');
const chatLogger = require('../utils/chatLogger');
const { runExclusive } = require('../utils/chatLock');
const { getSession, getAllSessions } = require('../bot/conversationMemory');
const { getMediaNoCaptionReply, getMediaCaptionPrefix } = require('../bot/prompts');
const adminCommands = require('../bot/adminCommands');
const botControl = require('../bot/botControl');

// --- Admin broadcast/campaign feature — safety rails (see conversation with
// the store owner 2026-07-14: whatsapp-web.js is an unofficial client, and
// bulk/broadcast sending is a well-known way these accounts get banned by
// WhatsApp regardless of a short fixed delay). These bound the blast radius
// of any single "ارسال عرض:" command:
//   - only customers active in the last BROADCAST_ACTIVE_WITHIN_MS (not the
//     entire all-time session history — cold contacts are a stronger
//     spam-report/ban signal than someone who messaged recently)
//   - hard ceiling MAX_BROADCAST_RECIPIENTS per run regardless of audience size
//   - randomized 8-15s delay (not a fixed 3-5s) between sends
//   - audiences over SAFE_AUTO_SEND_THRESHOLD require an explicit second
//     "تأكيد الإرسال" from the admin rather than sending immediately
//   - "إيقاف الإرسال" aborts an in-progress broadcast after the current message
const BROADCAST_ACTIVE_WITHIN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_BROADCAST_RECIPIENTS = 200;
const SAFE_AUTO_SEND_THRESHOLD = 50;
const BROADCAST_MIN_DELAY_MS = 8000;
const BROADCAST_MAX_DELAY_MS = 15000;
const PENDING_BROADCAST_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

let pendingBroadcast = null; // { text, recipients, createdAt }
let broadcastInProgress = false;
let broadcastAbortRequested = false;

function isBroadcastTrigger(text) {
  return normalizeArabic(text).startsWith(normalizeArabic('ارسال عرض'));
}

function isConfirmSend(text) {
  return normalizeArabic(text) === normalizeArabic('تأكيد الإرسال');
}

function isCancelSend(text) {
  return normalizeArabic(text) === normalizeArabic('إلغاء الإرسال');
}

function isStopSend(text) {
  return normalizeArabic(text) === normalizeArabic('إيقاف الإرسال');
}

// Extracts everything after the first colon in the ORIGINAL (non-normalized)
// text, so the broadcast content keeps the admin's exact wording/casing —
// normalizeArabic is only used to detect the trigger phrase itself.
function extractOfferText(rawText) {
  const colonIndex = rawText.search(/[:：]/);
  if (colonIndex === -1) return null;
  const offer = rawText.slice(colonIndex + 1).trim();
  return offer || null;
}

// Many contacts are stored under a privacy-mode "@lid" chatId rather than
// their real phone-number JID (confirmed in testing: the admin's own past
// test conversation is one of them) — sanitizePhoneNumber(chatId) on an @lid
// yields an opaque LID, not a real phone number, so comparing it directly
// against config.adminWhatsappNumber silently fails to exclude the admin.
// Resolve the real phone the same way the regular message handler already
// does, falling back to the raw chatId only if resolution fails.
async function resolveRealPhone(chatId) {
  try {
    const [resolved] = await client.getContactLidAndPhone([chatId]);
    if (resolved && resolved.pn) return sanitizePhoneNumber(resolved.pn);
  } catch (err) {
    logger.warn(`Could not resolve real phone number for broadcast candidate ${chatId}, using chat ID as-is.`);
  }
  return sanitizePhoneNumber(chatId);
}

// Unique phones from sessions active in the last week, most-recent-first,
// excluding the admin's own number — capped at MAX_BROADCAST_RECIPIENTS.
async function getBroadcastRecipients() {
  const cutoff = Date.now() - BROADCAST_ACTIVE_WITHIN_MS;
  const seenPhones = new Set();
  const candidates = [];

  for (const [chatId, session] of getAllSessions()) {
    if ((session.updatedAt || 0) < cutoff) continue;
    const phone = await resolveRealPhone(chatId);
    if (!phone || phone === config.adminWhatsappNumber) continue;
    if (seenPhones.has(phone)) continue;
    seenPhones.add(phone);
    candidates.push({ chatId, phone, updatedAt: session.updatedAt || 0 });
  }

  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates.slice(0, MAX_BROADCAST_RECIPIENTS);
}

function randomBroadcastDelayMs() {
  return BROADCAST_MIN_DELAY_MS + Math.floor(Math.random() * (BROADCAST_MAX_DELAY_MS - BROADCAST_MIN_DELAY_MS));
}

// Runs in the background (not awaited by the message handler) so the admin
// gets the "بدأنا" reply immediately rather than waiting for the whole
// campaign to finish sending.
async function runBroadcast(offerText, recipients) {
  broadcastInProgress = true;
  broadcastAbortRequested = false;
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += 1) {
    if (broadcastAbortRequested) break;
    const recipient = recipients[i];
    try {
      await client.sendMessage(recipient.chatId, offerText);
      sent += 1;
    } catch (err) {
      failed += 1;
      logger.error(`Broadcast offer failed to send to ${recipient.phone}.`, err);
    }
    logger.info(`Broadcast progress: ${sent + failed}/${recipients.length} (sent ${sent}, failed ${failed}).`);
    const isLast = i === recipients.length - 1;
    if (!isLast && !broadcastAbortRequested) {
      await sleep(randomBroadcastDelayMs());
    }
  }

  const aborted = broadcastAbortRequested;
  broadcastInProgress = false;
  broadcastAbortRequested = false;

  const summary = aborted
    ? `⏹️ تم إيقاف الإرسال يدوياً بعد ما اتبعت لـ ${sent} عميل من أصل ${recipients.length}${failed > 0 ? ` (وفشل الإرسال لـ ${failed})` : ''}.`
    : `تم إرسال العرض بنجاح إلى ${sent} عميل!${failed > 0 ? ` (وفشل الإرسال لـ ${failed} رقم)` : ''}`;
  await notifyAdmin(summary);
}

// Returns a reply string if this message was a broadcast-related command
// (trigger/confirm/cancel/stop), or null if it wasn't — in which case the
// caller falls through to the regular fixed admin commands.
async function handleBroadcastCommand(rawText) {
  if (isStopSend(rawText)) {
    if (!broadcastInProgress) return 'مفيش إرسال شغال دلوقتي عشان أوقفه.';
    broadcastAbortRequested = true;
    return '⏳ جاري إيقاف الإرسال بعد الرسالة الحالية...';
  }

  if (isConfirmSend(rawText)) {
    if (!pendingBroadcast) return 'مفيش عرض مستني تأكيد دلوقتي. ابعت "ارسال عرض: [نص العرض]" الأول.';
    if (Date.now() - pendingBroadcast.createdAt > PENDING_BROADCAST_EXPIRY_MS) {
      pendingBroadcast = null;
      return '⌛ العرض ده كان مستني تأكيد من زمان وانتهت صلاحيته. ابعت "ارسال عرض: [نص العرض]" تاني.';
    }
    const { text, recipients } = pendingBroadcast;
    pendingBroadcast = null;
    runBroadcast(text, recipients).catch((err) => logger.error('Broadcast run crashed.', err));
    return `جاري بدء إرسال العرض بأمان لـ ${recipients.length} عميل...`;
  }

  if (isCancelSend(rawText)) {
    if (!pendingBroadcast) return 'مفيش عرض مستني تأكيد عشان ألغيه.';
    pendingBroadcast = null;
    return 'تم إلغاء الإرسال.';
  }

  if (isBroadcastTrigger(rawText)) {
    if (broadcastInProgress) {
      return 'في إرسال عرض شغال دلوقتي بالفعل — استني لحد ما يخلص، أو ابعت "إيقاف الإرسال".';
    }
    const offerText = extractOfferText(rawText);
    if (!offerText) {
      return 'اكتب العرض بعد النقطتين كده: "ارسال عرض: [نص العرض]"';
    }
    const recipients = await getBroadcastRecipients();
    if (recipients.length === 0) {
      return `مفيش عملاء نشطين في آخر ${BROADCAST_ACTIVE_WITHIN_MS / (24 * 60 * 60 * 1000)} يوم عشان أبعتلهم العرض.`;
    }
    if (recipients.length > SAFE_AUTO_SEND_THRESHOLD) {
      pendingBroadcast = { text: offerText, recipients, createdAt: Date.now() };
      return (
        `⚠️ العرض ده هيتبعت لـ ${recipients.length} عميل (نشطين في آخر 7 أيام) — رقم كبير.\n` +
        `عشان نحمي رقم الواتساب من الحظر، ابعتلي "تأكيد الإرسال" عشان نكمل، أو "إلغاء الإرسال" عشان نلغي.`
      );
    }
    runBroadcast(offerText, recipients).catch((err) => logger.error('Broadcast run crashed.', err));
    return `جاري بدء إرسال العرض للعملاء بأمان... (${recipients.length} عميل)`;
  }

  return null;
}

const MEDIA_TYPE_LABELS_AR = {
  image: 'صورة',
  video: 'فيديو',
  ptt: 'رسالة صوتية',
  audio: 'ملف صوتي',
  document: 'ملف',
  sticker: 'ستيكر',
  location: 'موقع',
  vcard: 'جهة اتصال',
};

// Only these are real content a customer actually sent. Anything else with a
// non-"chat" type (e2e_notification, notification_template, group_notification,
// call_log, revoked, ...) is a WhatsApp protocol/system notice, not a message
// from the customer — these must be silently ignored, not replied to. Using
// an allowlist here (rather than "anything not chat") is what catches types
// we don't know about yet, since new system-notice types are on WhatsApp's
// side, not under our control.
const RECOGNIZED_MEDIA_TYPES = new Set([
  'image',
  'video',
  'ptt',
  'audio',
  'document',
  'sticker',
  'location',
  'vcard',
  'multi_vcard',
]);

let status = 'starting';
let client = null;

function getStatus() {
  return status;
}

function toWhatsAppJid(phoneOrJid) {
  return phoneOrJid.includes('@') ? phoneOrJid : `${phoneOrJid}@c.us`;
}

async function notifyAdmin(text) {
  if (!config.adminWhatsappNumber) return;
  if (!client || status !== 'connected') return;
  try {
    await client.sendMessage(toWhatsAppJid(config.adminWhatsappNumber), text);
    logger.info('Sent admin notification.');
  } catch (err) {
    logger.error('Failed to send admin notification. The bot continues running normally.', err);
  }
}

function createClient() {
  logger.info('WhatsApp client starting...');
  status = 'starting';

  if (config.adminWhatsappNumber) {
    logger.info(`Admin notifications enabled (order completions + unmatched product needs -> ${config.adminWhatsappNumber}).`);
  } else {
    logger.info('Admin notifications disabled (set ADMIN_WHATSAPP_NUMBER in .env to enable).');
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionPath }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  client.on('qr', (qr) => {
    status = 'qr_pending';
    logger.info('QR code ready. Scan it with WhatsApp (Linked Devices > Link a Device):');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    status = 'connected';
    logger.success('WhatsApp connected.');
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp authenticated.');
  });

  client.on('auth_failure', (message) => {
    status = 'auth_failure';
    logger.error(`WhatsApp authentication failure: ${message}`);
  });

  client.on('disconnected', (reason) => {
    status = 'disconnected';
    logger.warn(`WhatsApp disconnected: ${reason}. Attempting to reinitialize...`);
    setTimeout(() => {
      try {
        client.initialize();
      } catch (err) {
        logger.error('Failed to reinitialize WhatsApp client.', err);
      }
    }, 5000);
  });

  client.on('message', async (message) => {
    try {
      if (message.fromMe) return;
      if (message.from.endsWith('@g.us')) return; // ignore group chats
      if (message.from.endsWith('@broadcast')) return; // ignore WhatsApp Status updates
      // Ignore WhatsApp protocol/system notices (e2e_notification,
      // notification_template, group_notification, call_log, revoked, ...) —
      // these are not something the customer typed and must never get a reply.
      if (message.type && message.type !== 'chat' && !RECOGNIZED_MEDIA_TYPES.has(message.type)) {
        return;
      }

      // Serialize per-chat: if the same customer sends a burst of messages,
      // process them one at a time so they can't race on conversation state.
      await runExclusive(message.from, async () => {
        const receivedAt = Date.now();
        const contact = await message.getContact().catch(() => null);
        const senderName = (contact && (contact.pushname || contact.name)) || '';
        // message.from can be an opaque WhatsApp "LID" instead of the real phone
        // number (privacy-related contacts). Resolve the real phone JID explicitly.
        let phone = sanitizePhoneNumber(message.from);
        try {
          const [resolved] = await client.getContactLidAndPhone([message.from]);
          if (resolved && resolved.pn) {
            phone = sanitizePhoneNumber(resolved.pn);
          }
        } catch (err) {
          logger.warn(`Could not resolve real phone number for ${phone}, using WhatsApp ID as-is.`);
        }

        const isMedia = RECOGNIZED_MEDIA_TYPES.has(message.type);
        const caption = (message.body || '').trim();
        const logText = isMedia
          ? `[${MEDIA_TYPE_LABELS_AR[message.type] || message.type}]${caption ? `: ${caption}` : ''}`
          : message.body;

        logger.info(`Incoming message received from ${phone}: "${truncate(logText, 120)}"`);
        const stageBefore = getSession(message.from).stage;
        chatLogger.logIncoming({
          chatId: message.from,
          phone,
          senderName,
          message: logText,
          stage: stageBefore,
        });

        // Admin control channel: only the exact configured number, checked
        // against the resolved phone (not the raw JID) so it still works
        // through the LID-resolution path above. Takes priority over
        // everything else — including the pause state, since the admin must
        // always be able to send "تشغيل البوت" to resume it.
        if (config.adminWhatsappNumber && phone === config.adminWhatsappNumber) {
          const broadcastReply = await handleBroadcastCommand(message.body || '');
          const adminReply = broadcastReply !== null ? broadcastReply : await adminCommands.handleAdminMessage(message.body || '');
          await client.sendMessage(message.from, adminReply);
          logger.info(`Admin command handled for ${phone}: "${truncate(message.body || '', 120)}"`);
          return;
        }

        // Paused via the admin "وقف البوت" command: acknowledge nothing to
        // the customer (the admin is handling them manually) but keep the
        // incoming-message log above so there's still a record.
        if (botControl.isPaused()) {
          return;
        }

        // Pure media with no caption — nothing for the agent to act on. Reply
        // honestly (never go silent) and skip touching conversation state or
        // Sheets, since nothing about the customer's need actually changed.
        if (isMedia && !caption) {
          const reply = getMediaNoCaptionReply(message.type);
          await client.sendMessage(message.from, reply);
          logger.success(`Reply sent to ${phone} (media with no caption).`);
          chatLogger.logOutgoing({
            chatId: message.from,
            phone,
            senderName,
            message: reply,
            stage: stageBefore,
            latencyMs: Date.now() - receivedAt,
          });
          return;
        }

        const { reply, logEntry, adminNotification, orderHistoryEntry, variantId } = await agent.handleMessage({
          chatId: message.from,
          phone,
          text: message.body,
          senderName,
        });

        let sentReplyText = null;
        if (reply) {
          // Media with a caption: still process the caption normally, but be
          // upfront that the media itself wasn't seen.
          const finalReply = isMedia ? `${getMediaCaptionPrefix(message.type)}${reply}` : reply;
          sentReplyText = finalReply;
          await client.sendMessage(message.from, finalReply);
          logger.success(`Reply sent to ${phone}.`);
          const stageAfter = getSession(message.from).stage;
          chatLogger.logOutgoing({
            chatId: message.from,
            phone,
            senderName,
            message: finalReply,
            stage: stageAfter,
            latencyMs: Date.now() - receivedAt,
            variantId: variantId || null,
          });
        }

        if (logEntry) {
          // replyText feeds the Conversation History column in the Leads
          // sheet (see googleSheets.appendLead) — not part of logEntry itself
          // since only this call site knows what was actually sent.
          await googleSheets.appendLead({ ...logEntry, replyText: sentReplyText });
        }

        if (orderHistoryEntry) {
          // Separate from appendLead above — Order History is append-only
          // (one row per completed order), powering the returning-customer
          // memory feature in llmAgent.js. See googleSheets.logOrderHistory.
          await googleSheets.logOrderHistory(orderHistoryEntry);
        }

        if (adminNotification) {
          await notifyAdmin(adminNotification);
        }
      });
    } catch (err) {
      logger.error('Error while processing incoming message. The bot will continue running.', err);
    }
  });

  client.initialize();
  return client;
}

async function sendMessageToChatId(chatId, text) {
  if (!client || status !== 'connected') {
    throw new Error('WhatsApp client is not connected.');
  }
  return client.sendMessage(chatId, text);
}

// Called on SIGTERM/SIGINT (see src/index.js) so the puppeteer/Chrome
// subprocess and its session profile lock get torn down cleanly instead of
// being left behind for the next restart to collide with.
async function destroy() {
  if (!client) return;
  try {
    await client.destroy();
    logger.info('WhatsApp client destroyed cleanly.');
  } catch (err) {
    logger.error('Error while destroying the WhatsApp client.', err);
  }
}

module.exports = {
  createClient,
  getStatus,
  sendMessageToChatId,
  destroy,
};
