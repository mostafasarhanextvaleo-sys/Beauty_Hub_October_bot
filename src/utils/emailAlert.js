const nodemailer = require('nodemailer');
const logger = require('./logger');

const ALERT_TO = process.env.ALERT_RECIPIENT_EMAIL || 'mostafasarhanextvaleo@gmail.com';
// Prevents a crash loop or a health check that fails every cycle from
// flooding the inbox — one email per alert type per cooldown window, not per
// occurrence. alertType is only a dedup key, never shown to the recipient.
const COOLDOWN_MS = 15 * 60 * 1000;

let transporter = null;
let transporterInitError = null;
const lastSentAt = new Map();

function getTransporter() {
  if (transporter || transporterInitError) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    transporterInitError = new Error(
      'SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS must all be set in .env for email alerts to send.'
    );
    return null;
  }
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: parseInt(SMTP_PORT, 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendAlert(alertType, { subject, text }) {
  const now = Date.now();
  const last = lastSentAt.get(alertType) || 0;
  if (now - last < COOLDOWN_MS) {
    logger.info(`Email alert "${alertType}" suppressed (cooldown active, last sent ${Math.round((now - last) / 1000)}s ago).`);
    return;
  }

  const t = getTransporter();
  if (!t) {
    logger.warn(`Email alert "${alertType}" NOT sent — ${transporterInitError.message} (would have sent: "${subject}")`);
    return;
  }

  // Marked before the send resolves so an overlapping trigger during a slow
  // SMTP round-trip can't slip past the cooldown and double-send.
  lastSentAt.set(alertType, now);
  try {
    await t.sendMail({ from: process.env.SMTP_USER, to: ALERT_TO, subject, text });
    logger.info(`Email alert "${alertType}" sent to ${ALERT_TO}.`);
  } catch (err) {
    logger.error(`Failed to send email alert "${alertType}".`, err);
  }
}

module.exports = { sendAlert };
