const productMatcher = require('./productMatcher');
const { normalizeArabic } = require('../utils/helpers');
const embeddingService = require('../services/embeddingService');
const config = require('../config');
const logger = require('../utils/logger');

function tokenize(text) {
  return normalizeArabic(text)
    .split(' ')
    .filter((w) => w.length >= 2);
}

// Token-overlap scoring against name/description/benefits — name matches
// weigh heaviest since a direct brand/product-name search ("مويست وان") should
// win over an incidental mention buried in another product's description.
// Kept as the fallback path (2026-07-18): semanticSearch below is now primary,
// but this runs whenever embeddings aren't ready yet, the OpenAI embeddings
// call fails, or nothing scored above SIMILARITY_THRESHOLD — the bot must
// never lose the ability to find products just because embeddings are down.
function scoreProduct(tokens, product) {
  const name = normalizeArabic(product.name || '');
  const description = normalizeArabic(product.description || '');
  const benefits = normalizeArabic((product.benefits || []).join(' '));

  let score = 0;
  tokens.forEach((token) => {
    if (name.includes(token)) score += 3;
    if (description.includes(token)) score += 1;
    if (benefits.includes(token)) score += 1;
  });
  return score;
}

function keywordSearch(text, pool, { category = null, excludeIds = [], limit = 15 } = {}) {
  const tokens = tokenize(text);

  const ranked = tokens.length
    ? pool
        .map((p) => ({ product: p, score: scoreProduct(tokens, p) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.product)
    : [];

  // No keyword hits (e.g. "عايزة اشوف عروض البشرة") — fall back to a
  // category-only browse list instead of returning nothing.
  const candidates = ranked.length > 0 ? ranked : (category ? productMatcher.findByCategory(category) : []);

  const unseen = candidates.filter((p) => !excludeIds.includes(p.id));
  const finalPool = unseen.length > 0 ? unseen : candidates;

  return finalPool.slice(0, limit);
}

// --- Semantic (embedding-based) search, 2026-07-18 ---
// Replaces keyword matching as the primary path so a customer describing a
// need in their own words ("حاجة تشيل الهالات السودا تحت العين") — with no
// literal keyword overlap against the catalog text — still surfaces the
// right product. No external vector DB: the catalog is small enough (~800
// items) that an in-memory cosine-similarity scan over cached embeddings is
// instant, same "plain scan is sufficient at this scale" reasoning the
// original keyword search was built on.

// productId -> { embedding: number[], contentHash: string }
let productEmbeddings = new Map();
let embeddingsReady = false;

// What gets embedded for a product. IMPORTANT (verified empirically before
// shipping, 2026-07-18): this catalog's `description`/`benefits` fields are
// mostly auto-generated boilerplate repeated near-verbatim across hundreds of
// otherwise-unrelated products in the same category (e.g. nearly every
// bodycare item's description is some variant of "منتج عناية بالجسم - يعتني
// بجسمك ويمنحك إحساساً بالانتعاش"). Including that text diluted the
// embedding until a cleanser and a mascara scored within 0.002 of each other
// against a cleanser-seeking query — the boilerplate was drowning out the one
// field that's actually specific per product: the name. Weighting the name
// (repeated) over the generic description fixed the separation in testing.
// Keep this in mind if products.json ever gets richer, hand-written
// descriptions — re-including them would likely help rather than hurt then.
// 2026-07-18: skinType/hairType merged into a single targetType field (see
// productMatcher.js/googleSheetsProducts.js) — one line here instead of two,
// same weight contribution as before (a product only ever had one of the two
// populated to begin with, per category, so this doesn't dilute or
// double-count anything relative to the pre-merge text).
function productEmbeddingText(product) {
  return [
    product.name,
    product.name,
    product.category,
    Array.isArray(product.targetType) ? product.targetType.join('، ') : '',
  ]
    .filter(Boolean)
    .join(' — ');
}

// Cheap content fingerprint (not cryptographic) — just to detect "has this
// product's embeddable text changed since we last embedded it", so a refresh
// re-embeds only new/changed products instead of the whole catalog every time.
function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

// Re-embeds every product whose content is new or changed since the last
// pass, in a single batched OpenAI call — cheap even for the whole catalog,
// and a zero-API-call no-op on the common case (nothing changed since the
// last 5-minute refresh tick). Never throws.
async function refreshProductEmbeddings() {
  if (!config.semanticSearchEnabled) return;

  try {
    const products = productMatcher.getAllProducts();
    const toEmbed = [];
    const hashes = new Map();

    for (const product of products) {
      const text = productEmbeddingText(product);
      const hash = hashText(text);
      hashes.set(product.id, hash);
      const cached = productEmbeddings.get(product.id);
      if (!cached || cached.contentHash !== hash) {
        toEmbed.push({ id: product.id, text });
      }
    }

    // Drop embeddings for products no longer in the catalog (discontinued/removed).
    for (const id of [...productEmbeddings.keys()]) {
      if (!hashes.has(id)) productEmbeddings.delete(id);
    }

    if (toEmbed.length === 0) {
      embeddingsReady = productEmbeddings.size > 0;
      return;
    }

    const vectors = await embeddingService.embedTexts(toEmbed.map((p) => p.text));
    if (!vectors) {
      logger.warn(
        `Could not refresh ${toEmbed.length} product embedding(s) — semantic search will fall back to keyword matching for any product not already cached.`
      );
      return;
    }

    toEmbed.forEach((entry, i) => {
      productEmbeddings.set(entry.id, { embedding: vectors[i], contentHash: hashes.get(entry.id) });
    });
    embeddingsReady = productEmbeddings.size > 0;
    logger.success(`Refreshed embeddings for ${toEmbed.length} product(s) (${productEmbeddings.size} total cached).`);
  } catch (err) {
    logger.error('Product embedding refresh crashed — keyword search remains available as a fallback.', err);
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Minimum similarity to count as an actual match, not just "least dissimilar
// of a bad bunch" — conservative on purpose: a miss falls through to keyword
// search rather than risk confidently offering an unrelated product.
const SIMILARITY_THRESHOLD = 0.3;

// Returns null (never []) when semantic search can't confidently answer, so
// the caller knows to fall back to keyword search rather than treating "no
// match" as "there truly are zero relevant products".
async function semanticSearch(text, pool, { excludeIds = [], limit = 15 } = {}) {
  const queryVector = await embeddingService.embedText(text);
  if (!queryVector) return null;

  const scored = pool
    .filter((p) => productEmbeddings.has(p.id))
    .map((p) => ({ product: p, score: cosineSimilarity(queryVector, productEmbeddings.get(p.id).embedding) }))
    .filter((entry) => entry.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;

  const unseen = scored.filter((entry) => !excludeIds.includes(entry.product.id));
  const finalPool = (unseen.length > 0 ? unseen : scored).map((entry) => entry.product);

  return finalPool.slice(0, limit);
}

// Returns the best-matching candidate products for a user's free-text
// message, for injection into the LLM prompt as the ONLY products it may
// reference. Semantic search runs first when embeddings are ready; keyword
// search is the always-available fallback (embeddings not warmed up yet,
// OPENAI_API_KEY missing, the embeddings API call failing, or nothing
// scoring confidently) — this must never leave the bot unable to find a
// product just because an external API had a bad moment.
async function searchProducts(text, { category = null, excludeIds = [], limit = 15 } = {}) {
  const pool = productMatcher
    .getAllProducts()
    .filter((p) => p.inStock !== false && (!category || p.category === category));

  if (config.semanticSearchEnabled && embeddingsReady) {
    try {
      const semanticResults = await semanticSearch(text, pool, { excludeIds, limit });
      if (semanticResults) return semanticResults;
    } catch (err) {
      logger.error('Semantic product search failed — falling back to keyword search.', err);
    }
  }

  return keywordSearch(text, pool, { category, excludeIds, limit });
}

function isEmbeddingsReady() {
  return embeddingsReady;
}

function getEmbeddingCount() {
  return productEmbeddings.size;
}

const EMBEDDING_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // same cadence as productMatcher's own catalog refresh
let refreshTimer = null;

function startEmbeddingAutoRefresh(intervalMs = EMBEDDING_REFRESH_INTERVAL_MS) {
  if (refreshTimer || !config.semanticSearchEnabled) return;
  refreshTimer = setInterval(() => {
    refreshProductEmbeddings();
  }, intervalMs);
  if (refreshTimer.unref) refreshTimer.unref();
}

module.exports = {
  searchProducts,
  refreshProductEmbeddings,
  startEmbeddingAutoRefresh,
  isEmbeddingsReady,
  getEmbeddingCount,
};
