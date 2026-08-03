const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const OUT_PATH = path.join(__dirname, '..', '..', 'training-data', 'conversations.jsonl');

// Distillation capture: every validated OpenAI/Gemini reply from real traffic
// becomes one fine-tuning example (standard {role, content} chat format, the
// assistant turn being the exact JSON string the local model needs to learn
// to produce). Deliberately never called for providerUsed === 'local' — the
// local tier's own output is what we're trying to improve, not something to
// imitate.
//
// Contains real customer PII (names, phone numbers, addresses) via
// systemInstruction/contents/reply — training-data/conversations.jsonl is
// gitignored for that reason. Never throws; a logging failure must never
// break a live reply.
function logTrainingExample({ systemInstruction, contents, output, providerUsed }) {
  try {
    // `contents` is already the canonical {role, content} shape (see
    // llmAgent.js/openaiService.js) — this is exactly the OpenAI fine-tuning
    // messages format already, no conversion needed.
    const messages = [
      { role: 'system', content: systemInstruction },
      ...contents,
      { role: 'assistant', content: JSON.stringify(output) },
    ];

    const line = JSON.stringify({
      messages,
      meta: { providerUsed, ts: new Date().toISOString() },
    }) + '\n';

    fs.mkdir(path.dirname(OUT_PATH), { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        logger.error('Failed to create training-data directory. Skipping this training example.', mkdirErr);
        return;
      }
      fs.appendFile(OUT_PATH, line, (err) => {
        if (err) logger.error('Failed to append training example. Continuing without it.', err);
      });
    });
  } catch (err) {
    logger.error('Failed to build training example. Continuing without it.', err);
  }
}

module.exports = { logTrainingExample };
