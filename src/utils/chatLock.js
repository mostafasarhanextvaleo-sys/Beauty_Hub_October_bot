// Serializes async work per key (e.g. per WhatsApp chat ID) so that two
// messages arriving from the same chat in quick succession can't race on
// shared conversation state — each call waits for the previous one on the
// same key to finish before it starts. Different keys run fully in parallel.
const tails = new Map();

function runExclusive(key, fn) {
  const previous = tails.get(key) || Promise.resolve();
  const current = previous.then(fn, fn);

  const settled = current.catch(() => {});
  tails.set(key, settled);
  settled.finally(() => {
    if (tails.get(key) === settled) tails.delete(key);
  });

  return current;
}

module.exports = { runExclusive };
