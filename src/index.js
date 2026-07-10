const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const googleSheets = require('./services/googleSheets');
const whatsappClient = require('./whatsapp/client');
const productMatcher = require('./bot/productMatcher');
const cartRecovery = require('./bot/cartRecovery');

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (bot continues running).', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (bot continues running).', err);
});

function startExpressServer() {
  const app = express();

  app.get('/', (req, res) => {
    res.send('Beauty Hub October WhatsApp Bot is running');
  });

  app.get('/health', (req, res) => {
    res.json({
      store: config.storeName,
      whatsapp: {
        status: whatsappClient.getStatus(),
      },
      googleSheets: {
        enabled: googleSheets.isEnabled(),
        lastSuccessAt: googleSheets.getLastSuccessAt()
          ? new Date(googleSheets.getLastSuccessAt()).toISOString()
          : null,
        stale: googleSheets.isStale(),
      },
      products: {
        source: productMatcher.getSource(),
        count: productMatcher.getProductCount(),
      },
      aiProvider: config.aiProvider,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/reload-products', async (req, res) => {
    const refreshed = await productMatcher.refreshFromGoogleSheets();
    res.json({
      refreshedFromGoogleSheets: refreshed,
      source: productMatcher.getSource(),
      count: productMatcher.getProductCount(),
    });
  });

  app.listen(config.port, () => {
    logger.success(`Health server listening on http://localhost:${config.port}`);
  });
}

async function main() {
  logger.info(`Starting ${config.storeName} WhatsApp Bot...`);
  await googleSheets.init();
  googleSheets.startStalenessMonitor();
  await productMatcher.refreshFromGoogleSheets();
  productMatcher.startAutoRefresh();
  startExpressServer();
  whatsappClient.createClient();
  cartRecovery.startCartRecoveryScheduler(whatsappClient.sendMessageToChatId);
}

main();
