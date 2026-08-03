// Caps how many in-flight calls a given named resource (e.g. 'openai-chat')
// can have at once; excess calls queue in FIFO order and wait for a slot
// instead of firing immediately and colliding.
//
// 2026-07-28 audit (chat_history.log + PM2 error log, 2026-07-26 06:02-06:03
// burst): a WhatsApp reconnect delivered ~15 queued customer messages within
// 30 seconds. Every one of them fired its own concurrent OpenAI chat call,
// OpenAI embeddings call (product search), and — for whichever failed —
// a Gemini fallback call and Google Sheets writes, all with zero cap. The
// result: OpenAI embeddings failed with ECONNRESET, OpenAI chat calls timed
// out at 20s, Gemini failed in the same window, Google Sheets appends failed
// repeatedly, and several real customers got the generic "all tiers failed"
// canned reply with 22-47s latency. This doesn't fix any upstream rate
// limit — it just stops this process from being the thing that trips them by
// hammering every provider at once during a burst.
const queues = new Map(); // key -> { active: number, max: number, waiters: Function[] }

function getState(key, maxConcurrent) {
  let state = queues.get(key);
  if (!state) {
    state = { active: 0, max: maxConcurrent, waiters: [] };
    queues.set(key, state);
  }
  return state;
}

function acquire(key, maxConcurrent) {
  const state = getState(key, maxConcurrent);
  if (state.active < state.max) {
    state.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => state.waiters.push(resolve));
}

// Hands the freed slot directly to the next waiter rather than decrementing
// `active` and letting a fresh acquire() race for it — keeps FIFO order
// under contention.
function release(key) {
  const state = queues.get(key);
  if (!state) return;
  const next = state.waiters.shift();
  if (next) {
    next();
  } else {
    state.active -= 1;
  }
}

async function runLimited(key, maxConcurrent, fn) {
  await acquire(key, maxConcurrent);
  try {
    return await fn();
  } finally {
    release(key);
  }
}

module.exports = { runLimited };
