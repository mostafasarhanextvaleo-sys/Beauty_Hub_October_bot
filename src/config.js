const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const logger = require('./utils/logger');
require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  googleSheetId: process.env.GOOGLE_SHEET_ID || '',
  googleApplicationCredentials:
    process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials.json',
  aiProvider: (process.env.AI_PROVIDER || 'none').toLowerCase(),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  // 2026-07-18 audit: openaiService.js/embeddingService.js had no timeout at
  // all despite being the tiers actually live in production — a hung fetch
  // blocked a customer's entire conversation indefinitely and never reached
  // the "all tiers failed" admin alert. Mirrors localTimeoutMs's existing
  // pattern below.
  openaiTimeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS, 10) || 20000,
  // 2026-07-28 audit: caps for concurrencyLimiter.js, chosen from this
  // account's actual OpenAI rate-limit headers (checked live: 10,000 RPM /
  // 200,000 TPM for chat, 3,000 RPM for embeddings) — request-count headroom
  // is generous, so these aren't an attempt to max out the account. They
  // exist to smooth a burst of concurrent WhatsApp messages so they don't all
  // hit OpenAI/Gemini/Sheets in the same instant, which is what actually
  // caused the cascading failures seen in production (see that file's
  // comment for the incident). Gemini and Sheets are capped lower — Gemini
  // has shown real capacity-based outages independent of anything tunable
  // here, and Sheets' quota is tighter than either OpenAI budget.
  openaiChatConcurrency: parseInt(process.env.OPENAI_CHAT_CONCURRENCY, 10) || 8,
  openaiEmbeddingsConcurrency: parseInt(process.env.OPENAI_EMBEDDINGS_CONCURRENCY, 10) || 8,
  geminiConcurrency: parseInt(process.env.GEMINI_CONCURRENCY, 10) || 4,
  sheetsConcurrency: parseInt(process.env.SHEETS_CONCURRENCY, 10) || 4,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  sessionPath: process.env.SESSION_PATH || './.wwebjs_auth',
  storeName: 'Beauty Hub October',
  cartNudgeDelayHours: parseFloat(process.env.CART_NUDGE_DELAY_HOURS) || 3,
  // Second, sweeter nudge if the first one got no reply — measured from
  // nudgeSentAt (when the FIRST nudge went out), not from the original idle
  // time, so it's genuinely "24h after we last reached out", not "24h after
  // they went idle" (which the first nudge may have already covered).
  cartNudgeSecondDelayHours: parseFloat(process.env.CART_NUDGE_SECOND_DELAY_HOURS) || 24,
  adminWhatsappNumber: (process.env.ADMIN_WHATSAPP_NUMBER || '').trim(),
  // Shared secret required in the X-Reload-Token header to call
  // GET /reload-products — that endpoint triggers a Google Sheets API call,
  // so without this it's an open DoS/quota-exhaustion surface on anyone who
  // can reach the health-server port.
  reloadToken: (process.env.RELOAD_TOKEN || '').trim(),
  // 2026-07-30: invoices are generated on-the-fly by GET /invoice/:rowNumber
  // (src/index.js) and printed straight from the browser (Ctrl+P) — no PDF
  // storage, no Google Drive/OAuth. publicBaseUrl is the address that link
  // must use to work from a phone/laptop that isn't the server itself;
  // 'http://localhost:PORT' only resolves on the machine running the bot.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
  invoiceViewToken: (process.env.INVOICE_VIEW_TOKEN || '').trim(),
  // 2026-08-02: required header (X-Admin-Send-Token) on POST /admin/send-message
  // (src/index.js) — lets a single targeted WhatsApp message be triggered
  // through the already-running, already-authenticated bot process (e.g. a
  // manual follow-up to one customer) without ever spinning up a second
  // whatsapp-web.js client against the same session, which risks
  // corrupting/logging out the live one. Auto-generated like invoiceViewToken.
  adminSendToken: (process.env.ADMIN_SEND_TOKEN || '').trim(),
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

  // 2026-07-18: productSearch.js's primary matching path, backed by OpenAI
  // embeddings (src/services/embeddingService.js) — 'false' is an instant
  // rollback to the original keyword-only matcher if semantic search ever
  // misbehaves on real traffic, same rollback pattern as the flags above.
  semanticSearchEnabled: (process.env.SEMANTIC_SEARCH_ENABLED || 'true').toLowerCase() !== 'false',
};

config.credentialsAbsolutePath = path.isAbsolute(config.googleApplicationCredentials)
  ? config.googleApplicationCredentials
  : path.join(process.cwd(), config.googleApplicationCredentials);

// GET /invoice/:rowNumber exposes a customer's name/phone/address keyed by a
// small, guessable sequential row number — this token (required as a query
// param) is what stops anyone who can reach the port from just scanning
// /invoice/1, /invoice/2, ... for every order ever placed. Auto-generated
// once and appended to .env (rather than requiring manual setup) so it's
// zero-effort *and* stable across restarts — a token that regenerated on
// every restart would silently break every "Print Invoice" link already
// sitting in old Confirmed_Orders rows.
if (!config.invoiceViewToken) {
  config.invoiceViewToken = crypto.randomBytes(24).toString('hex');
  try {
    const envPath = path.join(process.cwd(), '.env');
    fs.appendFileSync(envPath, `\nINVOICE_VIEW_TOKEN=${config.invoiceViewToken}\n`);
    logger.info('Generated INVOICE_VIEW_TOKEN and saved it to .env (first run).');
  } catch (err) {
    logger.error(
      'Generated an INVOICE_VIEW_TOKEN but could not persist it to .env — it will regenerate (and invalidate every existing "Print Invoice" link) on the next restart until this is fixed.',
      err
    );
  }
}

if (!config.adminSendToken) {
  config.adminSendToken = crypto.randomBytes(24).toString('hex');
  try {
    const envPath = path.join(process.cwd(), '.env');
    fs.appendFileSync(envPath, `\nADMIN_SEND_TOKEN=${config.adminSendToken}\n`);
    logger.info('Generated ADMIN_SEND_TOKEN and saved it to .env (first run).');
  } catch (err) {
    logger.error('Generated an ADMIN_SEND_TOKEN but could not persist it to .env — it will regenerate on the next restart until this is fixed.', err);
  }
}

module.exports = config;
