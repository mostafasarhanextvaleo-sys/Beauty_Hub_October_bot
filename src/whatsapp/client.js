const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const logger = require('../utils/logger');
const agent = require('../bot/agent');
const googleSheets = require('../services/googleSheets');
const { sanitizePhoneNumber, truncate } = require('../utils/helpers');
const chatLogger = require('../utils/chatLogger');
const { runExclusive } = require('../utils/chatLock');
const { getSession } = require('../bot/conversationMemory');
const { getMediaNoCaptionReply, getMediaCaptionPrefix } = require('../bot/prompts');

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

        const { reply, logEntry, adminNotification, variantId } = await agent.handleMessage({
          chatId: message.from,
          phone,
          text: message.body,
          senderName,
        });

        if (reply) {
          // Media with a caption: still process the caption normally, but be
          // upfront that the media itself wasn't seen.
          const finalReply = isMedia ? `${getMediaCaptionPrefix(message.type)}${reply}` : reply;
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
          await googleSheets.appendLead(logEntry);
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

module.exports = {
  createClient,
  getStatus,
  sendMessageToChatId,
};
