const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('../config');
const logger = require('../utils/logger');
const agent = require('../bot/agent');
const googleSheets = require('../services/googleSheets');
const visionService = require('../services/visionService');
const productImageCache = require('../services/productImageCache');
const unlistedProductImageStore = require('../services/unlistedProductImageStore');
const { sanitizePhoneNumber, truncate, normalizeArabic, sleep, withTimeout } = require('../utils/helpers');
const chatLogger = require('../utils/chatLogger');
const { runExclusive } = require('../utils/chatLock');
const { getSession, updateSession, getAllSessions, isHumanHandoffCooldownActive } = require('../bot/conversationMemory');
const { getMediaNoCaptionReply, getMediaCaptionPrefix, MEDIA_ESCALATION_THRESHOLD } = require('../bot/prompts');
const adminCommands = require('../bot/adminCommands');
const adminAuth = require('../bot/adminAuth');
const botControl = require('../bot/botControl');
const emailAlert = require('../utils/emailAlert');
const campaignWorker = require('../bot/campaignWorker');
const deploymentAgent = require('../bot/deploymentAgent');

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
// 2026-07-30 incident: this is called once per stored session, serially, by
// both getBroadcastRecipients and buildPhoneToChatIdMap (used by
// orderPipeline.js) — with no timeout, a single hung puppeteer call (the exact symptom of a
// wedged renderer) stalled every remaining session behind it, turning a scan
// that should take seconds into one that never finished. RESOLVE_TIMEOUT_MS
// bounds each call so one stuck contact can't block the rest of the batch.
const RESOLVE_PHONE_TIMEOUT_MS = 8000;

async function resolveRealPhone(chatId) {
  try {
    const [resolved] = await Promise.race([
      client.getContactLidAndPhone([chatId]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('resolveRealPhone timed out')), RESOLVE_PHONE_TIMEOUT_MS)),
    ]);
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

// Reverse of what appendLead's phoneRowCache does: Sheets features that
// start from a bare phone number (e.g. orderPipeline.js reading
// Confirmed_Orders for staff-made status/action edits) need the actual
// chatId to send to — a phone alone isn't addressable via client.sendMessage() for
// @lid privacy-mode contacts. Reuses the same resolution as
// getBroadcastRecipients above; every phone in the Leads sheet originated
// from a real conversation, so it will have a resolvable session here.
async function buildPhoneToChatIdMap() {
  const map = new Map();
  for (const [chatId] of getAllSessions()) {
    const phone = await resolveRealPhone(chatId);
    if (phone) map.set(phone, chatId);
  }
  return map;
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

// 2026-08-09 vision feature — bounds message.downloadMedia(), which goes
// through the Puppeteer renderer (see the 2026-07-30 wedged-renderer incident
// elsewhere in this file's history) so it gets the same kind of hard timeout
// as every other renderer-touching call. The equivalent bound for outgoing
// product-photo fetches now lives in productImageCache.js, which owns that
// whole fetch-or-serve-from-disk path.
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15000;

let status = 'starting';
let client = null;

function getStatus() {
  return status;
}

// 2026-08-03 P0 fix: index.js used to start cartRecovery/deliveryFollowup/
// campaignWorker's timers unconditionally in main(), before WhatsApp ever
// finished authenticating — their first tick(s) could fire while
// sendMessageToChatId still threw "WhatsApp client is not connected.", and
// each scheduler had its own gap in how it handled that (see each module's
// own 2026-08-03 fix comments). Gating their *first* start on this instead
// of on a fixed delay means they come up as soon as WhatsApp is actually
// ready, however long that takes (instant reconnect vs. a fresh QR scan).
// Deliberately fires only once (readyCallbacks is drained and cleared) —
// this only needs to gate the very first start, not restart the schedulers
// on every later reconnect, which would duplicate their setInterval timers.
let readyCallbacks = [];
let hasBeenReady = false;

function onReady(callback) {
  if (hasBeenReady) {
    callback();
    return;
  }
  readyCallbacks.push(callback);
}

function fireReadyCallbacksOnce() {
  if (hasBeenReady) return;
  hasBeenReady = true;
  const callbacks = readyCallbacks;
  readyCallbacks = [];
  callbacks.forEach((cb) => cb());
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

// --- Health watchdog (added 2026-07-30 incident response) ---
// The 'disconnected'/'auth_failure' events above only fire when WhatsApp's
// own client-side JS reports a state change. The 2026-07-30 incident showed
// a failure mode those events never catch: the underlying Puppeteer/Chrome
// renderer's JS thread got wedged (confirmed via `ps` — a pinned near-100%
// CPU renderer, unrelated to WhatsApp session state), so every
// page.evaluate() call whatsapp-web.js makes (sendMessage, getState, ...)
// silently hung until Puppeteer's own protocol timeout, while `status`
// stayed 'connected' the whole time and PM2 saw a perfectly healthy process.
// Real customer replies stopped for 13+ hours with nothing surfacing it.
// This periodically proves liveness with the same evaluate() mechanism
// (client.getState()) under a short timeout, and if it's stuck for several
// consecutive checks, self-exits so PM2 relaunches with a fresh browser —
// deliberately not attempting client.destroy() first, since a wedged
// renderer is exactly the condition under which destroy() itself can hang
// (the graceful SIGTERM shutdown() path already has a 7s cap on that for the
// normal-shutdown case; this path assumes the worst and just exits).
const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000;
const HEALTH_CHECK_TIMEOUT_MS = 20 * 1000;
const MAX_CONSECUTIVE_HEALTH_FAILURES = 3; // ~9-12 min of proven unresponsiveness before acting

let healthWatchdogTimer = null;
let consecutiveHealthFailures = 0;
let restartingForUnresponsiveClient = false;

function withHealthCheckTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Health check timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runHealthCheck() {
  if (!client || status !== 'connected' || restartingForUnresponsiveClient) return;
  try {
    await withHealthCheckTimeout(client.getState(), HEALTH_CHECK_TIMEOUT_MS);
    consecutiveHealthFailures = 0;
  } catch (err) {
    consecutiveHealthFailures += 1;
    logger.error(
      `WhatsApp health check failed (${consecutiveHealthFailures}/${MAX_CONSECUTIVE_HEALTH_FAILURES}) — client may be unresponsive despite status="connected".`,
      err
    );
    if (consecutiveHealthFailures >= MAX_CONSECUTIVE_HEALTH_FAILURES) {
      await forceRestartUnresponsiveClient();
    }
  }
}

async function forceRestartUnresponsiveClient() {
  if (restartingForUnresponsiveClient) return;
  restartingForUnresponsiveClient = true;
  const minutesStuck = Math.round((HEALTH_CHECK_INTERVAL_MS * MAX_CONSECUTIVE_HEALTH_FAILURES) / 60000);
  logger.error(
    `WhatsApp client unresponsive for ~${minutesStuck} min despite reporting "connected" — this is the silent-hang failure mode. Exiting now so PM2 restarts with a clean browser.`
  );
  await emailAlert.sendAlert('whatsapp_unresponsive', {
    subject: '🚨 Beauty Hub Bot — WhatsApp client hung, auto-restarting',
    text:
      `The WhatsApp client stopped responding to internal health checks (${consecutiveHealthFailures} consecutive timeouts, ~${minutesStuck} min) ` +
      `even though it still reported "connected" — the underlying Chrome renderer got wedged. ` +
      `The bot process is exiting now so PM2 restarts it with a fresh browser. Customer replies were likely blocked until this restart completed.`,
  });
  // Same log-drain delay used elsewhere before process.exit() (src/index.js).
  setTimeout(() => process.exit(1), 300);
}

function startHealthWatchdog() {
  if (healthWatchdogTimer) clearInterval(healthWatchdogTimer);
  consecutiveHealthFailures = 0;
  healthWatchdogTimer = setInterval(() => {
    runHealthCheck().catch((err) => logger.error('Health watchdog crashed unexpectedly.', err));
  }, HEALTH_CHECK_INTERVAL_MS);
  if (healthWatchdogTimer.unref) healthWatchdogTimer.unref();
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
    // 2026-08-11 incident: WhatsApp's live web.whatsapp.com frontend build
    // changed and broke whatsapp-web.js@1.34.7's internal Store/WWebJS
    // injection — the page loads and fully authenticates (confirmed live:
    // the real chat list renders) but window.Store/window.WWebJS never
    // appear, so the library's 'ready' event never fires and the bot never
    // leaves "starting", even after multiple clean restarts. Without this
    // pin, the default webVersion ('2.3000.1017054665', an old hardcoded
    // library default not present in .wwebjs_cache/) never resolves from
    // the local cache, so every connect silently falls through to
    // fetching whatever WhatsApp serves live — there was no actual pinning
    // happening despite .wwebjs_cache/ already holding every previously
    // successful build. Pinned to the newest cached version confirmed to
    // have completed a real 'ready' event (2026-08-10T20:51:18Z, per
    // pm2 logs) via LocalWebCache's requestInterception path, sidestepping
    // today's breaking live change entirely.
    webVersion: '2.3000.1044858477',
    webVersionCache: { type: 'local' },
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
    restartingForUnresponsiveClient = false;
    startHealthWatchdog();
    // Needs a live, authenticated session (resolveRealPhone hits the same
    // puppeteer/CDP path as everything else here) — idempotent, so this is
    // safe to call on every reconnect, not just the first.
    campaignWorker.seedTargetedClientsOnce(resolveRealPhone).catch((err) => {
      logger.error('Targeted_Clients seeding failed.', err);
    });
    fireReadyCallbacksOnce();
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp authenticated.');
  });

  client.on('auth_failure', (message) => {
    status = 'auth_failure';
    logger.error(`WhatsApp authentication failure: ${message}`);
    emailAlert.sendAlert('whatsapp_auth_failure', {
      subject: '🚨 Beauty Hub Bot — WhatsApp authentication failed',
      text: `WhatsApp authentication failed: ${message}\n\nThe bot cannot send or receive messages until this is fixed — this usually needs a fresh QR scan (check pm2 logs beauty-hub-bot for the QR code).`,
    });
  });

  client.on('disconnected', (reason) => {
    status = 'disconnected';
    logger.warn(`WhatsApp disconnected: ${reason}. Attempting to reinitialize...`);
    emailAlert.sendAlert('whatsapp_disconnected', {
      subject: '⚠️ Beauty Hub Bot — WhatsApp disconnected',
      text: `WhatsApp disconnected (reason: ${reason}). The bot is attempting to automatically reinitialize in 5 seconds. If this doesn't resolve on its own, customer replies are blocked until it does.`,
    });
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
      // 2026-08-03 P1 addition — Targeted_Clients!Blocked: a hard blocklist,
      // checked before absolutely anything else (even auto-capture/logging,
      // unlike "Bot Paused" below which still records the contact normally).
      // Meant for spam/abusive numbers the owner wants the bot to fully
      // ignore, as if the message never arrived.
      if (campaignWorker.isContactBlocked(message.from)) {
        return;
      }

      // Serialize per-chat: if the same customer sends a burst of messages,
      // process them one at a time so they can't race on conversation state.
      await runExclusive(message.from, async () => {
        // Fire-and-forget, never awaited here — a real customer's reply must
        // never be delayed or blocked by a Sheets write to Targeted_Clients.
        // Errors are contained entirely inside campaignWorker.handleInboundMessage
        // itself. Deliberately called from *inside* this lock (not before it,
        // which is where this used to sit) — handleInboundMessage now takes
        // this same per-chatId lock internally (2026-08-03 concurrency fix,
        // see campaignWorker.js) to serialize against campaignWorker's other
        // Targeted_Clients writers. Calling it before this lock existed would
        // let its internal lock acquisition register on the same key first
        // and force this reply's own processing to queue behind a Sheets
        // round-trip — exactly the delay this comment has always warned
        // against. Since the outer lock here is already the current holder
        // by the time this fires, the nested acquisition just queues to run
        // after this turn finishes, with no such delay.
        campaignWorker.handleInboundMessage(message.from, message.body || '');

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

        // 2026-08-04 Dynamic Admin Privilege Escalation (store owner
        // directive): the configured admin number is now a standard customer
        // by default — it only reaches the real admin command channel while
        // Admin Mode is active (entered via typing "admin" 3 separate times
        // in a row, expires after 1h, exits early via "user" x3 — see
        // adminAuth.js for the whole state machine). Still checked against
        // the resolved phone (not the raw JID) so it works through the
        // LID-resolution path above, and still takes priority over
        // everything else that follows (pause state, human-handoff cooldown,
        // etc.) whenever this phone is actually inside Admin Mode.
        if (config.adminWhatsappNumber && phone === config.adminWhatsappNumber) {
          // 2026-08-06: checked first and unconditionally, independent of
          // the Admin Mode ritual below — modeled on the existing
          // session.awaitingDeliveryFeedback precedent (a contextual reply
          // is trusted only because the system itself just proactively
          // asked a specific question with a specific expected shape, never
          // because it's a general command channel). If this ran
          // after/inside the ritual dispatch instead, "Confirm 1" sent while
          // Admin Mode happens to already be active would be swallowed by
          // adminCommands.js's help-text fallback and never reach this
          // feature at all.
          const deploymentReply = await deploymentAgent.handleDeploymentMessage(message.body || '');
          if (deploymentReply !== null) {
            await client.sendMessage(message.from, deploymentReply);
            logger.info(`Deployment-agent command handled for ${phone}: "${truncate(message.body || '', 120)}"`);
            return;
          }

          const modeResult = adminAuth.processAdminModeMessage(message.from, message.body || '');
          if (modeResult.consumed) {
            await client.sendMessage(message.from, modeResult.reply);
            logger.info(`Admin-mode ritual message handled for ${phone}.`);
            return;
          }
          if (modeResult.isAdminCommand) {
            const broadcastReply = await handleBroadcastCommand(message.body || '');
            const adminReply = broadcastReply !== null ? broadcastReply : await adminCommands.handleAdminMessage(message.body || '');
            await client.sendMessage(message.from, adminReply);
            logger.info(`Admin command handled for ${phone}: "${truncate(message.body || '', 120)}"`);
            return;
          }
          // Not in Admin Mode and this wasn't the "admin" keyword ritual —
          // falls through below to the exact same normal-customer flow as
          // anyone else (auto-capture, human-handoff cooldown, Sara, Sheet
          // logging, everything), by design: this phone should be testable
          // as a real customer end to end.
        }

        // Fire-and-forget, same reasoning as handleInboundMessage above — a
        // real customer's reply must never be delayed or blocked by a Sheets
        // write. Auto-captures any brand-new contact into Targeted_Clients
        // (see campaignWorker.captureInboundLead) so no one who messages us
        // is missed for future offer campaigns, regardless of whether the
        // bot is paused or in human-handoff cooldown for them right now.
        campaignWorker.captureInboundLead(message.from, { phone, senderName, text: logText });

        // 2026-08-04 addition — same fire-and-forget reasoning as above.
        // Runs after captureInboundLead so a brand-new ad-click contact is
        // already inserted generically first, then immediately re-tagged
        // with the ad's specific Lead Source/category on top (see
        // campaignWorker.tagAdLead / adLeadDetector.js). Cheap no-op for
        // every message that isn't a recognized ad click-through.
        campaignWorker.tagAdLead(message.from, { phone, senderName, text: logText });

        // Human handoff cooldown (2026-07-16 spec): once this specific
        // customer has been handed to a human agent, the bot goes
        // completely silent for them for 24 hours — no LLM call, no reply,
        // no Sheet write, nothing — so the human has the conversation
        // entirely to themselves. WhatsApp itself still delivers the
        // message to the human agent same as always; this only stops the
        // BOT from acting on it. Checked before botControl.isPaused()
        // deliberately: this is a per-customer condition, that one is
        // global, and the more specific check should win first.
        // 2026-08-12 (store owner directive): the two protected admin/test
        // numbers must always get instant auto-replies, never auto-paused by
        // this cooldown under any circumstances — see
        // campaignWorker.isProtectedContact's header comment.
        if (!campaignWorker.isProtectedContact(message.from) && isHumanHandoffCooldownActive(getSession(message.from))) {
          logger.info(`Ignoring message from ${phone} — human handoff cooldown active (started ${new Date(getSession(message.from).humanHandoffAt).toISOString()}).`);
          return;
        }

        // 2026-08-03 P1 addition — Targeted_Clients!"Bot Paused (this
        // contact)": same per-customer-before-global priority reasoning as
        // the human handoff cooldown above, and checked right alongside it —
        // this is the sheet-driven equivalent for an owner who wants to
        // silence the bot for one specific customer without waiting for an
        // automatic handoff or pausing it for everyone via "وقف البوت".
        if (campaignWorker.isBotPausedForContact(message.from)) {
          logger.info(`Ignoring message from ${phone} — Bot Paused is set for this contact in Targeted_Clients.`);
          return;
        }

        // Paused via the admin "وقف البوت" command: acknowledge nothing to
        // the customer (the admin is handling them manually) but keep the
        // incoming-message log above so there's still a record.
        if (botControl.isPaused()) {
          return;
        }

        // 2026-08-09 vision feature — an incoming photo is no longer
        // automatically "unreadable": download it and ask OpenAI Vision for a
        // neutral description (see visionService.js), then let that flow into
        // the normal agent turn just like a caption would. Never blocks on a
        // download/analysis failure — falls through to the exact same "can't
        // see this" behavior that existed before this feature, so a Vision
        // API outage, a missing OPENAI_API_KEY, or a slow/wedged download
        // (message.downloadMedia() goes through the same Puppeteer renderer
        // implicated in the 2026-07-30 wedged-renderer incident elsewhere in
        // this file, hence the explicit timeout) degrades safely instead of
        // ever leaving the customer without a reply.
        let imageDescription = null;
        // 2026-08-18 addition — only populated when this customer is
        // currently answering Sara's "not available, send me a photo" ask
        // (session.awaitingUnlistedProductDetails, set by llmAgent.js). Saved
        // from the SAME already-downloaded `media` below rather than a
        // second downloadMedia() call, so a real photo isn't fetched twice
        // through the same Puppeteer renderer for one customer turn.
        let unlistedProductImageUrl = '';
        const awaitingUnlistedProductPhoto = Boolean(getSession(message.from).awaitingUnlistedProductDetails);
        if (message.type === 'image') {
          try {
            const media = await withTimeout(
              message.downloadMedia(),
              IMAGE_DOWNLOAD_TIMEOUT_MS,
              'message.downloadMedia (incoming image)'
            );
            if (media && media.data) {
              imageDescription = await visionService.analyzeImage({
                base64Data: media.data,
                mimeType: media.mimetype || 'image/jpeg',
                caption,
              });
              if (awaitingUnlistedProductPhoto) {
                unlistedProductImageUrl = unlistedProductImageStore.saveInboundImage({
                  base64Data: media.data,
                  mimeType: media.mimetype || 'image/jpeg',
                });
              }
            }
          } catch (err) {
            logger.error(`Failed to download/analyze incoming image from ${phone}.`, err);
          }
        }
        const imageUnderstood = Boolean(imageDescription);

        // Pure media with no caption AND not a successfully-analyzed image —
        // nothing for the agent to act on. Reply honestly (never go silent)
        // and skip touching conversation state or Sheets, since nothing about
        // the customer's need actually changed — except for the one small
        // piece of state this now tracks (2026-08-09 fix): consecutive
        // unreadable-media sends in a row, so the reply can degrade (normal
        // ack → catalog link → human handoff) instead of repeating the exact
        // same sentence forever. Confirmed live as a real failure mode — see
        // prompts.js's getMediaNoCaptionReply comment.
        if (isMedia && !caption && !imageUnderstood) {
          // 2026-08-18 — this path exits before ever reaching agent.handleMessage
          // (where the normal awaitingUnlistedProductDetails capture lives), so
          // a bare, caption-less photo sent as the answer to "send me a photo"
          // would otherwise be saved to disk (see unlistedProductImageUrl above)
          // but never logged to the sheet, nor clear the flag, if Vision also
          // happened to fail on it. Log it here directly instead — the photo
          // itself is real signal regardless of whether Vision could describe
          // it, and the customer still gets the normal graceful reply below.
          if (awaitingUnlistedProductPhoto && unlistedProductImageUrl) {
            updateSession(message.from, { awaitingUnlistedProductDetails: false });
            googleSheets
              .appendUnlistedProductRequest({ phone, customerName: senderName, productDetails: '', imageUrl: unlistedProductImageUrl })
              .catch((err) => logger.error(`Failed to log unlisted product request (photo-only) for ${phone}.`, err));
          }
          const mediaSession = getSession(message.from);
          const consecutiveUnreadableMedia = (mediaSession.consecutiveUnreadableMedia || 0) + 1;
          updateSession(message.from, { consecutiveUnreadableMedia });

          const reply = getMediaNoCaptionReply(message.type, consecutiveUnreadableMedia);
          await client.sendMessage(message.from, reply);
          logger.success(`Reply sent to ${phone} (media with no caption, consecutive miss #${consecutiveUnreadableMedia}).`);
          chatLogger.logOutgoing({
            chatId: message.from,
            phone,
            senderName,
            message: reply,
            stage: stageBefore,
            latencyMs: Date.now() - receivedAt,
          });

          if (consecutiveUnreadableMedia >= MEDIA_ESCALATION_THRESHOLD) {
            // Same human-handoff cooldown mechanism a genuine LLM-driven
            // handover uses (see conversationMemory.js's
            // isHumanHandoffCooldownActive) — the bot goes quiet for this
            // customer for 24h so a human has the conversation to themselves,
            // and doesn't keep re-escalating on every further media send.
            updateSession(message.from, { humanHandoffAt: Date.now(), consecutiveUnreadableMedia: 0 });
            await notifyAdmin(
              `📷 عميل بعت وسائط مش مقروءة ${consecutiveUnreadableMedia} مرات على التوالي — محتاج متابعة يدوية\n` +
                `رقم العميل: ${phone}\n` +
                `نوع آخر رسالة: ${message.type}`
            );
          }
          return;
        }

        // Any message that reaches the real agent (plain text, a successfully
        // analyzed image, or media WITH a caption the agent can act on) means
        // the customer got past the unreadable-media dead end, if they were
        // ever in it — reset so a later, unrelated media send starts counting
        // fresh instead of inheriting an old streak.
        if (getSession(message.from).consecutiveUnreadableMedia) {
          updateSession(message.from, { consecutiveUnreadableMedia: 0 });
        }

        // A successfully analyzed image's Vision description is passed
        // separately (imageContext), not merged into text here — llmAgent.js
        // combines them into what the AI/history actually see (modelText)
        // while keeping every deterministic intent detector (escalation,
        // order status, product-image request, ...) looking only at what the
        // customer actually typed. That split matters: a Vision description
        // routinely contains the word "صورة" itself (you can't describe a
        // photo without saying "photo"), which would otherwise falsely
        // trigger the outgoing product-photo request path on every single
        // analyzed incoming image. See llmAgent.js's handleMessage for the
        // full reasoning.
        const { reply, logEntry, adminNotification, orderHistoryEntry, variantId, productImage } = await agent.handleMessage({
          chatId: message.from,
          phone,
          text: message.body,
          senderName,
          imageContext: imageUnderstood ? imageDescription : undefined,
          unlistedProductImageUrl: unlistedProductImageUrl || undefined,
        });

        let sentReplyText = null;
        if (reply) {
          // Media with a caption that WASN'T understood (video/ptt/audio, or
          // an image whose analysis failed): still process the caption
          // normally, but be upfront that the media itself wasn't seen. A
          // successfully analyzed image skips this prefix — Sara genuinely
          // did see it.
          const finalReply = isMedia && !imageUnderstood ? `${getMediaCaptionPrefix(message.type)}${reply}` : reply;
          sentReplyText = finalReply;

          // 2026-08-09 outgoing product-photo feature (see llmAgent.js's
          // handleProductImageRequest) — strictly sheet-driven: productImage
          // only ever carries a URL that came straight from the Products
          // sheet's Image URL column, never anything guessed or searched.
          if (productImage && productImage.url) {
            let sentAsMedia = false;
            try {
              // 2026-08-09 — local disk cache (productImageCache.js) replaced
              // a direct MessageMedia.fromUrl call here. Root cause of the
              // repeated live timeouts (chatId 22299554107457@lid): genuine
              // throughput variability on the external image host, not
              // something a bigger timeout/more retries reliably fixes (the
              // SAME real URL measured ~3s to 20s+ across repeated fetches).
              // The cache still does exactly that retry-wrapped fetch on a
              // MISS (first request for a given product, or after its Sheet
              // URL changes) — but every request after that is served
              // straight from local disk, no network involved, so the
              // external host's reliability only matters once per product.
              const media = await productImageCache.getProductImageMedia(productImage.productId, productImage.url);
              if (media) {
                await client.sendMessage(message.from, media, { caption: finalReply });
                sentAsMedia = true;
              }
            } catch (err) {
              logger.error(
                `Failed to fetch/send product image for ${phone} (product: ${productImage.productName}, url: ${productImage.url}).`,
                err
              );
            }
            if (!sentAsMedia) {
              // 2026-08-09 addition — confirmed live (chatId
              // 22299554107457@lid): even with the retry above, the exact
              // same real image URL measured as low as ~3s and as high as
              // ~20s+ across repeated direct fetches within the same hour —
              // genuine external throughput variability on the image host's
              // side (TTFB was consistently fast; only sustained download
              // time varied), not a dead link or something fixable by
              // retrying harder/longer. A customer waiting in real time
              // shouldn't be made to wait even longer on the chance a 3rd/4th
              // attempt lands during a good window — instead, always hand her
              // the direct link as a tappable fallback so she can open the
              // photo herself regardless of whether WhatsApp's own media
              // upload succeeded. sentReplyText matches what's actually sent
              // (feeds chatLogger.logOutgoing + the Leads sheet's Conversation
              // History below).
              sentReplyText = `${finalReply}\n(معلش، مقدرتش أبعت الصورة كملف دلوقتي — تقدري تفتحيها من هنا: ${productImage.url})`;
              await client.sendMessage(message.from, sentReplyText);
            }
          } else {
            await client.sendMessage(message.from, finalReply);
          }

          logger.success(`Reply sent to ${phone}.`);
          const stageAfter = getSession(message.from).stage;
          chatLogger.logOutgoing({
            chatId: message.from,
            phone,
            senderName,
            // sentReplyText (not finalReply) — the only one of the two that's
            // guaranteed to match what actually reached the customer, since
            // the product-image fallback above can append an apology line
            // that finalReply alone never reflects.
            message: sentReplyText,
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
          // Additive campaign hook — only touches Confirmed_Orders/
          // Targeted_Clients if this chat happens to be a campaign target;
          // never blocks or fails the real order logging above. Address comes
          // from logEntry (deliveryAddress), not orderHistoryEntry, which
          // doesn't carry it — see buildLogEntryAndNotification in llmAgent.js.
          campaignWorker
            .handleOrderConfirmed(message.from, {
              customerName: orderHistoryEntry.customerName,
              phone: orderHistoryEntry.phone,
              address: logEntry && logEntry.deliveryAddress,
              products: orderHistoryEntry.productName,
              totalPrice: orderHistoryEntry.price,
              // 2026-08-19 addition — see llmAgent.js's buildLogEntryAndNotification,
              // which sets this on logEntry from applied.orderData.shippingMethod
              // (already re-verified against the real zone table there).
              shippingMethod: logEntry && logEntry.shippingMethod,
              // 2026-08-19 addition — same threading, for the new "Quantity"
              // Confirmed_Orders column. Note: orderHistoryEntry.price/products
              // (used just above) are ALREADY the quantity-multiplied total and
              // the quantity-annotated product name (see
              // buildLogEntryAndNotification) — this field is additionally for
              // the dedicated structured column, not what makes the total itself
              // correct.
              quantity: logEntry && logEntry.quantity,
            })
            .catch((err) => {
              logger.error('Campaign Confirmed_Orders logging failed (order itself was still logged normally).', err);
            });
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
  if (healthWatchdogTimer) clearInterval(healthWatchdogTimer);
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
  buildPhoneToChatIdMap,
  resolveRealPhone,
  destroy,
  onReady,
};
