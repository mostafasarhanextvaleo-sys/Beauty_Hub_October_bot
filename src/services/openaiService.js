const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

async function generateReply(systemPrompt, userMessage) {
  if (!config.openaiApiKey) {
    logger.warn('OpenAI provider selected but OPENAI_API_KEY is missing. Falling back to rule-based agent.');
    return null;
  }

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`OpenAI API error: ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    logger.error('Failed to call OpenAI API. Falling back to rule-based agent.', err);
    return null;
  }
}

// Fallback provider for the LLM agent (src/bot/llmAgent.js) when Gemini is
// unavailable. Mirrors geminiService.generateStructuredReply's signature
// exactly (same `contents` shape, same responseSchema object) so llmAgent.js
// can call either provider interchangeably without a translation layer of
// its own. Converts Gemini-style contents ({role:'user'|'model', parts:[{text}]})
// to OpenAI's messages format ({role:'system'|'user'|'assistant', content}).
// Never throws — returns null on any failure, same convention as generateReply.
async function generateStructuredReply({ systemInstruction, contents, responseSchema }) {
  if (!config.openaiApiKey) {
    logger.warn('OPENAI_API_KEY missing. Cannot use OpenAI as the LLM-agent fallback.');
    return null;
  }

  const messages = [
    { role: 'system', content: systemInstruction },
    ...contents.map((turn) => ({
      role: turn.role === 'model' ? 'assistant' : 'user',
      content: (turn.parts || []).map((p) => p.text).join('\n'),
    })),
  ];

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.4,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'agent_reply', schema: responseSchema, strict: true },
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`OpenAI API error (structured fallback): ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      logger.warn('OpenAI structured fallback returned no content.');
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      logger.error('OpenAI structured fallback returned non-JSON despite json_schema mode.', err);
      return null;
    }
  } catch (err) {
    logger.error('Failed to call OpenAI API for LLM-agent fallback.', err);
    return null;
  }
}

module.exports = { generateReply, generateStructuredReply };
