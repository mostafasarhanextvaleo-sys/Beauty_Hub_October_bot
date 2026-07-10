const productMatcher = require('./productMatcher');
const { normalizeArabic } = require('../utils/helpers');

function tokenize(text) {
  return normalizeArabic(text)
    .split(' ')
    .filter((w) => w.length >= 2);
}

// Token-overlap scoring against name/description/benefits — name matches
// weigh heaviest since a direct brand/product-name search ("مويست وان") should
// win over an incidental mention buried in another product's description.
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

// Returns the best-matching candidate products for a user's free-text
// message, for injection into the LLM prompt as the ONLY products it may
// reference. No embeddings/vector DB — the catalog is small enough (~800
// items) that a plain scored scan is instant and sufficient.
function searchProducts(text, { category = null, excludeIds = [], limit = 15 } = {}) {
  const tokens = tokenize(text);
  const pool = productMatcher
    .getAllProducts()
    .filter((p) => p.inStock !== false && (!category || p.category === category));

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

module.exports = { searchProducts };
