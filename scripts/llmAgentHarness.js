// Local test harness for the LLM-driven agent (src/bot/llmAgent.js).
//
// Calls llmAgent.handleMessage(...) directly per line typed, using the real
// conversationMemory session store and the real Gemini/OpenAI APIs, so state
// persists turn-to-turn exactly like production — but WITHOUT ever touching
// googleSheets.appendLead or notifyAdmin (those live in src/whatsapp/client.js,
// not llmAgent.js), so nothing here writes to the live Leads sheet or pages
// the real admin number. Safe to run against production config/API keys.
//
// Usage: node scripts/llmAgentHarness.js [chatId]

const readline = require('readline');
const llmAgent = require('../src/bot/llmAgent');

const chatId = process.argv[2] || 'harness-test@c.us';
const phone = chatId.split('@')[0];

console.log(`LLM agent harness — chatId=${chatId}. Type a message and press Enter. Ctrl+C to quit.\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
rl.prompt();

// Piped/scripted input (e.g. `printf "..." | node harness.js`) closes stdin
// right after the last line, which would otherwise fire 'close' — and this
// process would exit — before the in-flight Gemini/OpenAI network call
// finishes. Chaining every line onto one promise and awaiting it on 'close'
// (rather than exiting immediately) lets scripted single-shot runs actually
// see their result instead of being killed mid-request.
let queue = Promise.resolve();

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }

  queue = queue.then(async () => {
    try {
      const result = await llmAgent.handleMessage({ chatId, phone, text, senderName: 'Harness Tester' });
      console.log('\n--- reply ---');
      console.log(result.reply);
      console.log('--- logEntry (would be appended to Leads sheet in production) ---');
      console.log(JSON.stringify(result.logEntry, null, 2));
      if (result.adminNotification) {
        console.log('--- adminNotification (would be sent to admin WhatsApp in production) ---');
        console.log(result.adminNotification);
      }
      console.log(`--- variantId: ${result.variantId} ---\n`);
    } catch (err) {
      console.error('Harness error:', err);
    }
    rl.prompt();
  });
});

rl.on('close', () => {
  queue.then(() => {
    console.log('\nBye.');
    process.exit(0);
  });
});
