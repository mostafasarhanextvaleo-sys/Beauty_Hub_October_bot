// Retries a transient failure a bounded number of times with jittered
// exponential backoff, instead of giving up on the first blip. See
// concurrencyLimiter.js for the burst scenario this and it were both added
// to handle (2026-07-28 audit) — a single retry would very plausibly have
// succeeded once a message burst's initial spike passed, instead of
// immediately falling through the whole tier chain (or, for Google Sheets,
// silently losing the lead write).
//
// Never retries indefinitely, and never retries a failure the caller's
// isRetryable() doesn't recognize (e.g. a 401/malformed-request 4xx) —
// retrying a guaranteed-to-fail call only adds latency for nothing. The
// caller's own fallback chain (llmAgent.js's tier list) remains the backstop
// once retries are exhausted.
async function retryAsync(fn, { retries = 2, baseDelayMs = 400, isRetryable = () => true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      const jitter = Math.random() * baseDelayMs;
      const delay = baseDelayMs * 2 ** attempt + jitter;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// Network-level errors (connection reset, DNS hiccup, our own withTimeout
// race) and HTTP-level throws that carry a retryable status code (429 rate
// limit, 5xx) — the two error shapes seen in practice across node-fetch
// (message text) and googleapis (err.code / err.response.status).
function isTransientError(err) {
  const code = err && (err.code || (err.response && err.response.status));
  if (code === 429 || (typeof code === 'number' && code >= 500)) return true;
  const msg = (err && err.message) || '';
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|Timed out after/.test(msg);
}

module.exports = { retryAsync, isTransientError };
