const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// RESPONSE_SCHEMA is already standard JSON Schema (the dialect written for
// OpenAI's strict json_schema mode — lowercase types, nullable via a
// ["<type>","null"] union) — Ollama's `format` field accepts this dialect
// as-is, so unlike geminiService.js there's no schema conversion needed here.

// Primary tier for the LLM agent (src/bot/llmAgent.js). Tries each configured
// local model in order (e.g. gemma2 primary, then a lighter qwen2.5 backup)
// against the local Ollama server before the caller falls through to
// OpenAI/Gemini. Mirrors geminiService/openaiService's generateStructuredReply
// signature exactly so llmAgent.js can call any of the three interchangeably.
// Never throws — returns null on any failure, same convention as the others.
async function generateStructuredReply({ systemInstruction, contents, responseSchema }) {
  const messages = [
    { role: 'system', content: systemInstruction },
    ...contents.map((turn) => ({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: (turn.parts || []).map((p) => p.text).join('\n'),
    })),
  ];

  for (const model of config.localModels) {
    try {
      const response = await withTimeout(
        fetch(`${config.ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            format: responseSchema,
            stream: false,
            options: { temperature: 0.4 },
          }),
        }),
        config.localTimeoutMs,
        `Ollama /api/chat (${model})`
      );

      if (!response.ok) {
        const errText = await response.text();
        logger.error(`Local model "${model}" error: ${response.status} ${errText}`);
        continue;
      }

      const data = await response.json();
      const text = data.message?.content;
      if (!text) {
        logger.warn(`Local model "${model}" returned no content.`);
        continue;
      }

      try {
        return JSON.parse(text);
      } catch (err) {
        logger.error(`Local model "${model}" returned non-JSON despite schema format.`, err);
        continue;
      }
    } catch (err) {
      logger.error(`Failed to call local model "${model}".`, err);
      continue;
    }
  }

  return null;
}

module.exports = { generateStructuredReply };
