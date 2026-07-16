const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const googleSheets = require('./services/googleSheets');
const whatsappClient = require('./whatsapp/client');
const productMatcher = require('./bot/productMatcher');
const cartRecovery = require('./bot/cartRecovery');
const deliveryFollowup = require('./bot/deliveryFollowup');

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (bot continues running).', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (bot continues running).', err);
});

// Constant-time compare so a mistyped/missing token can't be distinguished
// from a correct one by response-timing side channel. Buffers must be equal
// length for timingSafeEqual, so a length mismatch is handled as "not equal"
// up front rather than throwing.
function tokensMatch(provided, expected) {
  const a = Buffer.from(provided || '', 'utf8');
  const b = Buffer.from(expected || '', 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

let shuttingDown = false;

// PM2 sends SIGTERM/SIGINT on every restart/stop. Without this, Node's
// default handling exits immediately and leaves the puppeteer/Chrome
// subprocess (and its session profile lock) behind — the exact cause of a
// prior incident where the WhatsApp client hung for 10+ minutes after a
// restart instead of reconnecting in its normal ~5-15s. Bounded by a timeout
// so a hung client.destroy() can't block shutdown forever either.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  const destroyWithTimeout = Promise.race([
    whatsappClient.destroy(),
    new Promise((resolve) => setTimeout(resolve, 7000)),
  ]);

  try {
    await destroyWithTimeout;
  } catch (err) {
    logger.error('Error while destroying the WhatsApp client during shutdown.', err);
  } finally {
    logger.info('Shutdown complete.');
    // console.log/warn/error write to a pipe under pm2, which Node flushes
    // asynchronously — calling process.exit() in the same tick can truncate
    // whatever was just logged (this is why "destroyed cleanly"/"Shutdown
    // complete" were silently missing from the log despite the code running).
    // A short delay gives the pipe a chance to drain before the process ends.
    setTimeout(() => process.exit(0), 300);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
    if (!config.reloadToken || !tokensMatch(req.header('X-Reload-Token'), config.reloadToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
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
  deliveryFollowup.startDeliveryFollowupScheduler(whatsappClient.sendMessageToChatId, whatsappClient.buildPhoneToChatIdMap);
}

main();
