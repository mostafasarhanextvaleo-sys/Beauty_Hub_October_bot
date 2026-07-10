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

module.exports = { generateReply };
