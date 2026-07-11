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
  // llmAgent.js's tier order is local -> openai -> gemini. Gemini is now the
  // last tier, so this flag gates whether it's tried at all after both the
  // local model and OpenAI have failed — 'false' goes straight to the static
  // canned reply instead.
  geminiFallbackEnabled: (process.env.GEMINI_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false',
  // Comma-separated WhatsApp phone numbers allowed to use the LLM agent even
  // when agentMode is 'rules' — lets the LLM agent be canaried on a few real
  // numbers before flipping AGENT_MODE globally.
  llmAgentTestChatIds: (process.env.LLM_AGENT_TEST_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // --- Local-first tier (primary, tried before openai/gemini) ---
  ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  localModels: (process.env.LOCAL_MODELS || 'gemma2:2b-instruct-q4_K_M,qwen2.5:1.5b')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  localTimeoutMs: parseInt(process.env.LOCAL_TIMEOUT_MS, 10) || 20000,
  // Master kill switch for the local tier — 'false' skips straight to
  // openai/gemini for everyone regardless of localAgentTestChatIds.
  localAgentEnabled: (process.env.LOCAL_AGENT_ENABLED || 'true').toLowerCase() !== 'false',
  // Canary gate, independent of llmAgentTestChatIds (which gates llm-vs-rules
  // mode overall, already moot now that AGENT_MODE=llm is live for everyone).
  // Empty by default: the local tier is wired in but attempted for nobody
  // until specific WhatsApp numbers are added here, since the raw local model
  // has known accuracy gaps (intent/handover misclassification) pending the
  // planned fine-tuning pass. Non-listed numbers still get the new
  // openai -> gemini order, just without the local step.
  localAgentTestChatIds: (process.env.LOCAL_AGENT_TEST_CHAT_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

config.credentialsAbsolutePath = path.isAbsolute(config.googleApplicationCredentials)
  ? config.googleApplicationCredentials
  : path.join(process.cwd(), config.googleApplicationCredentials);

module.exports = config;
