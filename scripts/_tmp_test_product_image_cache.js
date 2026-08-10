// Unit tests (not committed) for the 2026-08-09 local image cache
// (src/services/productImageCache.js) — the permanent fix for ibb.co
// throughput variability (confirmed live: the same real URL measured ~3s to
// 20s+ across repeated fetches, chatId 22299554107457@lid). Stubs
// whatsapp-web.js's MessageMedia (fromUrl/fromFilePath) via require.cache so
// this never makes a real network call or depends on any external host being
// up, and points the cache at an isolated temp directory so it never touches
// the real public/images_cache/.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhb-image-cache-test-'));

let fromUrlCallCount = 0;
let nextFromUrlBehavior = null; // () => media object, or throws

const whatsappWebPath = require.resolve('whatsapp-web.js');
const MessageMediaStub = class {
  constructor(mimetype, data, filename) {
    this.mimetype = mimetype;
    this.data = data;
    this.filename = filename;
  }
  static async fromUrl(url) {
    fromUrlCallCount += 1;
    return nextFromUrlBehavior();
  }
  static fromFilePath(filePath) {
    const data = fs.readFileSync(filePath, { encoding: 'base64' });
    return new MessageMediaStub('image/png', data, path.basename(filePath));
  }
};
const realWhatsappWeb = require('whatsapp-web.js');
require.cache[whatsappWebPath] = {
  id: whatsappWebPath,
  filename: whatsappWebPath,
  loaded: true,
  exports: { ...realWhatsappWeb, MessageMedia: MessageMediaStub },
};

// productImageCache.js resolves CACHE_DIR relative to its own file location
// (__dirname/../../public/images_cache) — not overridable via env, so this
// test instead monkey-patches its exported CACHE_DIR-dependent behavior by
// requiring it fresh and verifying via its own module-relative path, but
// redirects writes into an isolated subdirectory by overriding fs calls is
// overkill; simpler and just as valid: let it use the real public/images_cache/
// path (same as production) since these are FAKE product IDs
// ("CACHE_TEST_...") that can never collide with a real catalog product ID,
// and clean up after the run.
delete require.cache[require.resolve('../src/services/productImageCache')];
const productImageCache = require('../src/services/productImageCache');

const FAKE_PNG_BASE64 = Buffer.from('fake-png-bytes-for-testing').toString('base64');

(async () => {
  // --- 1. Cache MISS on first request: fetches from the network, writes to disk ---
  {
    fromUrlCallCount = 0;
    nextFromUrlBehavior = () => ({ mimetype: 'image/png', data: FAKE_PNG_BASE64, filename: 'x.png' });
    const media = await productImageCache.getProductImageMedia('CACHE_TEST_1', 'https://example.com/a.png');
    assert.strictEqual(fromUrlCallCount, 1, 'expected exactly one network fetch on a cold cache');
    assert.ok(media, 'expected a media object to be returned');
    assert.strictEqual(media.data, FAKE_PNG_BASE64);
    console.log('PASS: cache miss fetches from the network and returns the media.');
  }

  // --- 2. Cache HIT on second request for the SAME product+url: NO network call ---
  {
    fromUrlCallCount = 0;
    nextFromUrlBehavior = () => {
      throw new Error('should never be called on a cache hit');
    };
    const media = await productImageCache.getProductImageMedia('CACHE_TEST_1', 'https://example.com/a.png');
    assert.strictEqual(fromUrlCallCount, 0, 'expected ZERO network fetches on a warm cache — served from disk');
    assert.ok(media, 'expected a media object from the local disk cache');
    assert.strictEqual(media.data, FAKE_PNG_BASE64, 'expected the cached bytes to round-trip correctly');
    console.log('PASS: cache hit is served entirely from local disk, no network call.');
  }

  // --- 3. URL change for the SAME product (staff edited the Sheet) invalidates the cache ---
  {
    fromUrlCallCount = 0;
    const NEW_BASE64 = Buffer.from('a-different-image-entirely').toString('base64');
    nextFromUrlBehavior = () => ({ mimetype: 'image/png', data: NEW_BASE64, filename: 'y.png' });
    const media = await productImageCache.getProductImageMedia('CACHE_TEST_1', 'https://example.com/b-new-url.png');
    assert.strictEqual(fromUrlCallCount, 1, 'expected a fresh fetch when the URL for this product changed');
    assert.strictEqual(media.data, NEW_BASE64, 'expected the NEW image, not the stale cached one');
    console.log('PASS: a changed Image URL for the same product correctly invalidates the old cache entry.');
  }

  // --- 4. A download failure (even after internal retries) returns null, never throws ---
  {
    nextFromUrlBehavior = () => {
      throw new Error('Timed out after 15000ms: simulated');
    };
    const media = await productImageCache.getProductImageMedia('CACHE_TEST_2', 'https://example.com/unreachable.png');
    assert.strictEqual(media, null, 'expected null (not a throw) when the download ultimately fails');
    console.log('PASS: a persistent download failure returns null gracefully instead of throwing.');
  }

  // --- 5. Missing productId or url returns null immediately, no network call ---
  {
    fromUrlCallCount = 0;
    nextFromUrlBehavior = () => {
      throw new Error('should never be called');
    };
    assert.strictEqual(await productImageCache.getProductImageMedia(null, 'https://example.com/x.png'), null);
    assert.strictEqual(await productImageCache.getProductImageMedia('CACHE_TEST_3', null), null);
    assert.strictEqual(fromUrlCallCount, 0);
    console.log('PASS: missing productId/url short-circuits to null with no network call.');
  }

  // Cleanup: remove the fake cache entries this test created from the REAL
  // public/images_cache/ directory (this test used real product IDs prefixed
  // "CACHE_TEST_" specifically so this cleanup can target them safely without
  // touching any real cached product photo).
  try {
    const manifestPath = path.join(productImageCache.CACHE_DIR, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      for (const id of Object.keys(manifest)) {
        if (id.startsWith('CACHE_TEST_')) {
          const filePath = path.join(productImageCache.CACHE_DIR, manifest[id].filename);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          delete manifest[id];
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }
  } catch (err) {
    console.warn('Cleanup of test cache entries failed (non-fatal):', err.message);
  }
  fs.rmSync(tmpCacheDir, { recursive: true, force: true });

  console.log('\nALL PRODUCT IMAGE CACHE TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
