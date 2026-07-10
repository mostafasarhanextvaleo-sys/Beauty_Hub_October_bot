const path = require('path');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  googleSheetId: process.env.GOOGLE_SHEET_ID || '',
  googleApplicationCredentials:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials.json',
  aiProvider: (process.env.AI_PROVIDER || 'none').toLowerCase(),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  sessionPath: process.env.SESSION_PATH || './.wwebjs_auth',
  storeName: 'Beauty Hub October',
  cartNudgeDelayHours: parseFloat(process.env.CART_NUDGE_DELAY_HOURS) || 3,
  adminWhatsappNumber: (process.env.ADMIN_WHATSAPP_NUMBER || '').trim(),
  // 'rules' = existing STAGES state machine (default, proven on live traffic).
  // 'llm' = free-form Gemini-driven agent (src/bot/llmAgent.js). Switching back
  // to 'rules' is an instant rollback if the LLM agent misbehaves on real traffic.
  agentMode: (process.env.AGENT_MODE || 'rules').toLowerCase(),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  // If the Gemini call fails, llmAgent.js falls back to openaiService's
  // structured-output path (gpt-4o-mini) before ever falling back to a static
  // canned reply. Set to 'false' to disable and go straight to the canned reply.
  geminiFallbackEnabled: (process.env.GEMINI_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false',
  // Comma-separated WhatsApp phone numbers allowed to use the LLM agent even
  // when agentMode is 'rules' — lets the LLM agent be canaried on a few real
  // numbers before flipping AGENT_MODE globally.
  llmAgentTestChatIds: (process.env.LLM_AGENT_TEST_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

config.credentialsAbsolutePath = path.isAbsolute(config.googleApplicationCredentials)
  ? config.googleApplicationCredentials
  : path.join(process.cwd(), config.googleApplicationCredentials);

module.exports = config;
