const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');

// 2026-08-18 — storage for photos customers send of a product we don't carry
// (see llmAgent.js's awaitingUnlistedProductDetails / googleSheets.js's
// appendUnlistedProductRequest). Deliberately its own tiny module rather than
// folded into productImageCache.js — that module caches OUTGOING product
// photos keyed by a real catalog productId; this is a one-shot save of an
// INCOMING customer photo with no product identity at all, a different
// concern with a different lifecycle (never invalidated/re-fetched, just
// written once).
const STORE_DIR = path.join(__dirname, '..', '..', 'public', 'unlisted_product_requests');
const URL_PREFIX = '/unlisted-product-images';

const MIMETYPE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function ensureDir() {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
}

// Saves one inbound customer photo to local disk and returns a real,
// publicly-reachable URL for it (same PUBLIC_BASE_URL + nginx-proxy pattern
// already used for /invoice and /catalog — see index.js's static mount for
// this same URL_PREFIX, and /etc/nginx/sites-available/beautyhub's matching
// location block). Returns '' — never throws, never invents a URL — if
// PUBLIC_BASE_URL isn't configured or the write fails; the sheet row this
// feeds is still logged either way, just without a photo link, same "never
// invent data" discipline rule 8 already applies to prices/availability.
function saveInboundImage({ base64Data, mimeType }) {
  if (!base64Data) return '';
  if (!config.publicBaseUrl) {
    logger.warn(
      'PUBLIC_BASE_URL not configured — cannot build a public URL for an unlisted-product-request photo; logging without one.'
    );
    return '';
  }
  try {
    ensureDir();
    const extension = MIMETYPE_EXTENSIONS[mimeType] || '.jpg';
    const filename = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${extension}`;
    fs.writeFileSync(path.join(STORE_DIR, filename), Buffer.from(base64Data, 'base64'));
    return `${config.publicBaseUrl}${URL_PREFIX}/${filename}`;
  } catch (err) {
    logger.error('Failed to save an unlisted-product-request photo to disk.', err);
    return '';
  }
}

module.exports = { saveInboundImage, STORE_DIR, URL_PREFIX };
