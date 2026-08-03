const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');
const { resilientFetch } = require('../utils/resilientFetch');

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
// Cost-effective embedding model (not the larger -3-large) — catalog text is
// short product descriptions, not documents, so the smaller model's accuracy
// is plenty and it's a fraction of the cost.
const EMBEDDING_MODEL = 'text-embedding-3-small';

// Batched: one HTTP round trip embeds every input string at once (OpenAI's
// endpoint accepts an array, well under its ~2048-input limit for our
// ~800-product catalog), rather than one request per product — this is what
// makes re-embedding the whole catalog cheap and fast instead of hundreds of
// sequential calls. Never throws — returns null on any failure so callers
// (productSearch.js) can fall back to keyword search, same convention as
// openaiService.js/geminiService.js.
async function embedTexts(texts) {
  if (!config.openaiApiKey) {
    logger.warn('OPENAI_API_KEY missing. Cannot compute embeddings.');
    return null;
  }
  if (texts.length === 0) return [];

  try {
    const response = await resilientFetch(
      'openai-embeddings',
      config.openaiEmbeddingsConcurrency,
      () =>
        fetch(OPENAI_EMBEDDINGS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.openaiApiKey}`,
          },
          body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
        }),
      { timeoutMs: config.openaiTimeoutMs, label: 'OpenAI /embeddings' }
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`OpenAI embeddings API error: ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    // Defensive: the API documents in-order results, but sort by `index`
    // explicitly rather than trust that under all conditions.
    const sorted = [...data.data].sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
  } catch (err) {
    logger.error('Failed to call OpenAI embeddings API.', err);
    return null;
  }
}

async function embedText(text) {
  const result = await embedTexts([text]);
  return result ? result[0] : null;
}

module.exports = { embedTexts, embedText, EMBEDDING_MODEL };
