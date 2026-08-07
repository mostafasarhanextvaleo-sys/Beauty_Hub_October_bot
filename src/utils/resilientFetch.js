const { runLimited } = require('./concurrencyLimiter');
const { retryAsync, isTransientError } = require('./retry');

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Composes concurrencyLimiter + retry specifically for a fetch() call:
// caps how many concurrent requests a given resource can have in flight
// (see concurrencyLimiter.js), and retries a bounded number of times on a
// retryable HTTP status or network-level failure. Returns the Response
// object exactly as a plain `await withTimeout(fetch(...), ...)` would —
// callers keep their existing `if (!response.ok) {...}` handling unchanged;
// this only changes what happens before that point.
async function resilientFetch(resourceKey, maxConcurrent, fetchFn, { timeoutMs, label, retries = 2, baseDelayMs = 400 }) {
  return runLimited(resourceKey, maxConcurrent, () =>
    retryAsync(
      async () => {
        const response = await withTimeout(fetchFn(), timeoutMs, label);
        if (!response.ok && RETRYABLE_STATUS.has(response.status)) {
          const err = new Error(`${label} returned retryable status ${response.status}`);
          err.code = response.status;
          throw err;
        }
        return response;
      },
      { retries, baseDelayMs, isRetryable: isTransientError }
    )
  );
}

module.exports = { resilientFetch };
