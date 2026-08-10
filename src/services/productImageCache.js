const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MessageMedia } = require('whatsapp-web.js');
const logger = require('../utils/logger');
const { withTimeout } = require('../utils/helpers');
const { retryAsync, isTransientError } = require('../utils/retry');

// 2026-08-09 addition — permanent fix for the ibb.co throughput-variability
// incidents (confirmed live, chatId 22299554107457@lid: the SAME real image
// URL measured anywhere from ~3s to 20s+ across repeated fetches, sometimes
// blowing past even a retried 15s timeout budget). Once a product's image has
// been fetched successfully once, every later request for that same product
// is served straight from local disk (MessageMedia.fromFilePath — synchronous,
// no network involved) instead of ever touching the external host again,
// until the Sheet's Image URL for that product actually changes.
const CACHE_DIR = path.join(__dirname, '..', '..', 'public', 'images_cache');
const MANIFEST_PATH = path.join(CACHE_DIR, 'manifest.json');
const FETCH_TIMEOUT_MS = 15000;

// productId -> { url, filename, mimetype, cachedAt }
let manifest = {};
let manifestLoaded = false;

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadManifest() {
  if (manifestLoaded) return;
  manifestLoaded = true;
  ensureCacheDir();
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    }
  } catch (err) {
    logger.warn('Product image cache manifest was unreadable/corrupt — starting with an empty cache.', err);
    manifest = {};
  }
}

function saveManifest() {
  try {
    ensureCacheDir();
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch (err) {
    // The cache entry already lives in the in-memory `manifest` object, so a
    // write failure here only risks losing that entry on the NEXT process
    // restart (falls back to re-downloading once, exactly like a cold cache)
    // — never something that should block sending the image this turn.
    logger.error('Failed to persist product image cache manifest to disk.', err);
  }
}

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

const MIMETYPE_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// Returns a whatsapp-web.js MessageMedia instance for this product's photo —
// from the local disk cache when one already exists for this EXACT url
// (a staff edit to the Sheet's Image URL naturally invalidates the old
// cache entry, since the url comparison below will no longer match), or by
// downloading fresh and caching for every future request otherwise. Never
// throws — returns null on any failure (download/timeout, unreadable local
// file, disk write failure) so the caller can fall back to a text link, same
// convention as visionService.analyzeImage/openaiService.
async function getProductImageMedia(productId, url) {
  if (!productId || !url) return null;
  loadManifest();

  const cached = manifest[productId];
  if (cached && cached.url === url) {
    const localPath = path.join(CACHE_DIR, cached.filename);
    if (fs.existsSync(localPath)) {
      try {
        return MessageMedia.fromFilePath(localPath);
      } catch (err) {
        logger.warn(`Product image cache file for product ${productId} was unreadable — re-downloading.`, err);
      }
    }
  }

  let media;
  try {
    media = await retryAsync(
      () =>
        withTimeout(
          MessageMedia.fromUrl(url, { unsafeMime: true }),
          FETCH_TIMEOUT_MS,
          'MessageMedia.fromUrl (product image cache fill)'
        ),
      { retries: 1, baseDelayMs: 500, isRetryable: isTransientError }
    );
  } catch (err) {
    logger.error(`Failed to download product image for local caching (product ${productId}, url: ${url}).`, err);
    return null;
  }

  // Persist to disk so every later request for this product is instant and
  // never touches the external host again. Caching is an optimization on top
  // of an already-successful fetch — a failure here must never throw away the
  // media we already have for THIS turn.
  try {
    ensureCacheDir();
    const extension = MIMETYPE_EXTENSIONS[media.mimetype] || '';
    const filename = `${productId}_${hashUrl(url)}${extension}`;
    const localPath = path.join(CACHE_DIR, filename);
    fs.writeFileSync(localPath, Buffer.from(media.data, 'base64'));

    // Best-effort cleanup of a previous cached file for this product (a
    // now-superseded Image URL) so the cache directory doesn't grow
    // unbounded across image swaps over time.
    if (cached && cached.filename && cached.filename !== filename) {
      fs.unlink(path.join(CACHE_DIR, cached.filename), () => {});
    }

    manifest[productId] = { url, filename, mimetype: media.mimetype, cachedAt: new Date().toISOString() };
    saveManifest();
  } catch (err) {
    logger.error(`Failed to persist product image to local cache (product ${productId}) — sending it this turn regardless.`, err);
  }

  return media;
}

module.exports = { getProductImageMedia, CACHE_DIR };
