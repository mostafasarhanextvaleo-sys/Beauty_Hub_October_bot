const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../utils/logger');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

async function generateReply(systemPrompt, userMessage) {
  if (!config.anthropicApiKey) {
    logger.warn('Anthropic provider selected but ANTHROPIC_API_KEY is missing. Falling back to rule-based agent.');
    return null;
  }

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      logger.error(`Anthropic API error: ${response.status} ${errText}`);
      return null;
    }

    const data = await response.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch (err) {
    logger.error('Failed to call Anthropic API. Falling back to rule-based agent.', err);
    return null;
  }
}

module.exports = { generateReply };
