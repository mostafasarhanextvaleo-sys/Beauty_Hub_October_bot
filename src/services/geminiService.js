const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');
const { resilientFetch } = require('../utils/resilientFetch');

const REQUEST_TIMEOUT_MS = 15 * 1000;

// The canonical RESPONSE_SCHEMA (llmSystemPrompt.js) is written in standard
// JSON Schema (lowercase types, nullable via a ["<type>","null"] union) so it
// works as-is for OpenAI's strict json_schema mode. Gemini's REST API uses a
// different dialect (uppercase Type enum strings, a boolean `nullable` flag
// instead of a type union) — this converts one to the other so there's still
// only one schema to hand-maintain.
function toGeminiSchema(schema) {
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.find((t) => t !== 'null');
    const { type, ...rest } = schema;
    return { ...toGeminiSchema({ ...rest, type: nonNull }), nullable: true };
  }

  const converted = { type: schema.type.toUpperCase() };
  if (schema.description) converted.description = schema.description;
  if (schema.enum) converted.enum = schema.enum;
  if (schema.items) converted.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)])
    );
  }
  if (schema.required) converted.required = schema.required;
  return converted;
}

// llmAgent.js stores session.llm.history (and passes `contents`) in the
// canonical OpenAI chat shape ({role: 'user'|'assistant', content: string}) —
// openaiService.js/localService.js consume that directly. Gemini's REST API
// is the one dialect that actually differs (role 'model' instead of
// 'assistant', text nested under parts[]), so it converts here instead of
// making every other tier carry a translation layer for Gemini's sake.
function toGeminiContents(contents) {
  return contents.map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));
}

// Single structured-output call: the model MUST return a schema-conformant
// JSON object (generationConfig.responseSchema), so the caller never has to
// regex-parse free text for control-flow signals (order data, handover flag).
// Never throws — returns null on any failure so the caller can fall back
// (see llmAgent.js: Gemini -> OpenAI structured fallback -> static canned reply).
async function generateStructuredReply({ systemInstruction, contents, responseSchema }) {
  if (!config.geminiApiKey) {
    logger.warn('GEMINI_API_KEY missing. Cannot call Gemini.');
    return null;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: toGeminiContents(contents),
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(responseSchema),
      temperature: 0.4,
    },
  };

  try {
    const response = await resilientFetch(
      'gemini',
      config.geminiConcurrency,
      () =>
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': config.geminiApiKey,
          },
          body: JSON.stringify(body),
        }),
      { timeoutMs: REQUEST_TIMEOUT_MS, label: 'Gemini generateContent' }
    );

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`Gemini API error: ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
      logger.warn(`Gemini finished with reason "${candidate.finishReason}" — treating as unusable.`);
      return null;
    }

    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      logger.warn('Gemini returned no text content.');
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      logger.error('Gemini returned non-JSON despite JSON mode.', err);
      return null;
    }
  } catch (err) {
    logger.error('Failed to call Gemini API. Falling back.', err);
    return null;
  }
}

module.exports = { generateStructuredReply };
