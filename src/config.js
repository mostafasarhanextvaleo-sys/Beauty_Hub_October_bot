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
};

config.credentialsAbsolutePath = path.isAbsolute(config.googleApplicationCredentials)
  ? config.googleApplicationCredentials
  : path.join(process.cwd(), config.googleApplicationCredentials);

module.exports = config;
