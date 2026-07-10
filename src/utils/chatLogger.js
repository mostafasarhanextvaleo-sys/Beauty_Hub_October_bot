const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const CHAT_LOG_PATH = path.join(__dirname, '..', '..', 'chat_history.log');
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 5;

// Prevents chat_history.log from growing forever. Rotates to .1, .2, ... once
// the active file exceeds MAX_LOG_SIZE_BYTES, keeping at most MAX_ROTATED_FILES
// backups.
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(CHAT_LOG_PATH)) return;
    if (fs.statSync(CHAT_LOG_PATH).size < MAX_LOG_SIZE_BYTES) return;

    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = `${CHAT_LOG_PATH}.${i}`;
      const dest = `${CHAT_LOG_PATH}.${i + 1}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dest);
      }
    }
    fs.renameSync(CHAT_LOG_PATH, `${CHAT_LOG_PATH}.1`);
    logger.info(`Rotated chat_history.log (exceeded ${MAX_LOG_SIZE_BYTES / (1024 * 1024)}MB).`);
  } catch (err) {
    logger.error('Failed to rotate chat_history.log. Continuing to append to the existing file.', err);
  }
}

function appendLine(entry) {
  rotateIfNeeded();
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(CHAT_LOG_PATH, line, (err) => {
    if (err) {
      logger.error('Failed to write to chat_history.log. Continuing without this chat log entry.', err);
    }
  });
}

// One JSON object per line (JSONL) so it can be parsed directly for analytics
// (funnel-stage progression, response latency) instead of regex-scraped text.
function logIncoming({ chatId, phone, senderName, message, stage }) {
  appendLine({
    ts: new Date().toISOString(),
    dir: 'IN',
    chatId,
    phone,
    name: senderName || '',
    stage: stage || null,
    text: message || '',
  });
}

function logOutgoing({ chatId, phone, senderName, message, stage, latencyMs, variantId }) {
  appendLine({
    ts: new Date().toISOString(),
    dir: 'OUT',
    chatId,
    phone,
    name: senderName || '',
    stage: stage || null,
    text: message || '',
    latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
    variantId: variantId || null,
  });
}

module.exports = { logIncoming, logOutgoing };
