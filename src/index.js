const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const logger = require('./utils/logger');
const googleSheets = require('./services/googleSheets');
const { buildInvoiceHtml } = require('./utils/invoiceGenerator');
const whatsappClient = require('./whatsapp/client');
const productMatcher = require('./bot/productMatcher');
const productSearch = require('./bot/productSearch');
const cartRecovery = require('./bot/cartRecovery');
const deliveryFollowup = require('./bot/deliveryFollowup');
const campaignWorker = require('./bot/campaignWorker');
const campaignKnowledge = require('./bot/campaignKnowledge');
const deploymentAgent = require('./bot/deploymentAgent');
const emailAlert = require('./utils/emailAlert');
const { runExclusive } = require('./utils/chatLock');

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (bot continues running).', reason);
  // Non-fatal by design (see uncaughtException below for why crashes are
  // treated differently) — but still worth an alert since "the bot kept
  // running" doesn't mean the rejected operation succeeded. emailAlert's own
  // per-type cooldown keeps a burst of these from spamming the inbox.
  emailAlert.sendAlert('unhandled_rejection', {
    subject: '⚠️ Beauty Hub Bot — unhandled promise rejection',
    text: `An unhandled promise rejection occurred. The bot process is continuing to run (this is not a crash), but the underlying operation likely failed silently.\n\n${reason && reason.stack ? reason.stack : reason}`,
  });
});

// 2026-07-18 audit: continuing after an uncaughtException is exactly what
// Node's own docs warn against — the process may be left with a stuck lock,
// a half-mutated session, or a broken listener, silently, for however long
// until the next restart. PM2 is already configured to auto-restart on
// exit, so failing fast here recovers in seconds instead of running an
// unknown length of time in a possibly-corrupted state. (unhandledRejection
// above stays non-fatal — many libraries have legitimate rejections handled
// elsewhere; uncaughtException means something escaped every handler.)
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — exiting so PM2 can restart cleanly.', err);
  // Bounded the same way as shutdown()'s client.destroy() below — a crash is
  // exactly the moment SMTP might also be unreachable, and this must not
  // delay the exit/restart PM2 depends on.
  const alertWithTimeout = Promise.race([
    emailAlert.sendAlert('uncaught_exception', {
      subject: '🚨 Beauty Hub Bot — CRASHED (uncaught exception)',
      text: `The bot process hit an uncaught exception and is exiting for PM2 to restart it.\n\n${err && err.stack ? err.stack : err}`,
    }),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  // Same log-drain delay as shutdown() below — process.exit() in the same
  // tick as a console.error can truncate the very line explaining why.
  alertWithTimeout.finally(() => setTimeout(() => process.exit(1), 300));
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
  app.use(express.json());

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
        semanticSearch: {
          enabled: config.semanticSearchEnabled,
          ready: productSearch.isEmbeddingsReady(),
          embeddedCount: productSearch.getEmbeddingCount(),
        },
      },
      aiProvider: config.aiProvider,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Zero-storage printable invoice: rendered fresh on every request straight
  // from the Confirmed_Orders row, no PDF/Drive/OAuth involved — the store
  // owner opens the "Print Invoice" link from the Sheet and hits Ctrl+P.
  // Token-gated (constant-time compare, same as /reload-products above) since
  // rowNumber is a small guessable integer and the row holds a customer's
  // name/phone/address.
  app.get('/invoice/:rowNumber', async (req, res) => {
    if (!config.invoiceViewToken || !tokensMatch(req.query.token, config.invoiceViewToken)) {
      return res.status(401).send('Unauthorized');
    }
    const rowNumber = parseInt(req.params.rowNumber, 10);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      return res.status(400).send('Invalid order reference.');
    }
    try {
      const order = await googleSheets.getConfirmedOrderByRow(rowNumber);
      if (!order) return res.status(404).send('Order not found.');
      const html = buildInvoiceHtml({
        invoiceNumber: `BHO-${rowNumber}`,
        dateLabel: (order.date || '').slice(0, 10),
        customerName: order.customerName,
        phone: order.phone,
        address: order.address,
        products: order.products,
        productTotal: order.totalPrice,
      });
      res.set('Content-Type', 'text/html; charset=utf-8').send(html);
    } catch (err) {
      logger.error(`Failed to render printable invoice for Confirmed_Orders row ${rowNumber}.`, err);
      res.status(500).send('Failed to load invoice.');
    }
  });

  app.get('/reload-products', async (req, res) => {
    if (!config.reloadToken || !tokensMatch(req.header('X-Reload-Token'), config.reloadToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const refreshed = await productMatcher.refreshFromGoogleSheets();
    await productSearch.refreshProductEmbeddings();
    res.json({
      refreshedFromGoogleSheets: refreshed,
      source: productMatcher.getSource(),
      count: productMatcher.getProductCount(),
      embeddings: { ready: productSearch.isEmbeddingsReady(), count: productSearch.getEmbeddingCount() },
    });
  });

  // 2026-08-02: lets a single targeted WhatsApp message be sent through the
  // already-running, already-authenticated bot process (e.g. a manual
  // follow-up to one customer) — deliberately NOT a second whatsapp-web.js
  // client, since a second Puppeteer instance against the same LocalAuth
  // session risks corrupting/logging out the live one serving every real
  // customer. Records the sent text into that chat's session history (same
  // helper campaignWorker.js uses for its own sends) so the customer's next
  // reply is still answered in context, not from stale/unrelated history.
  app.post('/admin/send-message', async (req, res) => {
    if (!config.adminSendToken || !tokensMatch(req.header('X-Admin-Send-Token'), config.adminSendToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { chatId, text } = req.body || {};
    if (!chatId || !text) {
      return res.status(400).json({ error: 'chatId and text are required.' });
    }
    try {
      await whatsappClient.sendMessageToChatId(chatId, text);
      // Locked per-chatId (2026-08-03), same key/lock as whatsapp/client.js's
      // own message-handling lock and campaignWorker.js's offer sends — this
      // writes the whole session.llm.history array, and so does an in-flight
      // reply to this same chatId; without a shared lock whichever finishes
      // last would silently overwrite the other's turn.
      await runExclusive(chatId, async () => campaignWorker.appendOfferToSessionHistory(chatId, text));
      logger.success(`Admin-triggered message sent to ${chatId}.`);
      res.json({ sent: true });
    } catch (err) {
      logger.error(`Admin-triggered message failed for ${chatId}.`, err);
      res.status(500).json({ error: 'Failed to send message.' });
    }
  });

  // 2026-08-06: hand-off point for scripts/scheduledReport.js (a standalone
  // process run 3x/day via system cron) — deliberately NOT a direct write to
  // pending_confirmations.json from that separate process. deploymentAgent.js
  // is the sole writer of that file (via chatLock's runExclusive), so a
  // report landing here while a live Confirm/Deploy action is mid-flight
  // can never race it into a lost update. Same token-gate pattern as
  // /admin/send-message above.
  app.post('/admin/submit-report', async (req, res) => {
    if (!config.adminSendToken || !tokensMatch(req.header('X-Admin-Send-Token'), config.adminSendToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { summary, actionItems } = req.body || {};
    if (!summary || !Array.isArray(actionItems)) {
      return res.status(400).json({ error: 'summary (string) and actionItems (array) are required.' });
    }
    try {
      const newItems = await deploymentAgent.submitReport({ summary, actionItems });
      res.json({ accepted: true, items: newItems });
    } catch (err) {
      logger.error('Failed to submit scheduled report to deploymentAgent.', err);
      res.status(500).json({ error: 'Failed to process report.' });
    }
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
  await campaignKnowledge.refresh();
  campaignKnowledge.startAutoRefresh();
  // Bot Paused (this contact) only needs Sheets, not WhatsApp — start this
  // independently of the onReady-gated schedulers below so a pause set before
  // the very first customer message already lands still takes effect.
  campaignWorker.startPausedContactsAutoRefresh();
  // Warm the semantic-search embedding cache before the WhatsApp client goes
  // live, so the very first customer message already gets embedding-based
  // matching instead of falling back to keyword search for its first 5
  // minutes. Never blocks startup on failure — refreshProductEmbeddings()
  // logs and returns if OPENAI_API_KEY is missing or the API call fails, and
  // productSearch.js falls back to keyword matching either way.
  await productSearch.refreshProductEmbeddings();
  productSearch.startEmbeddingAutoRefresh();
  startExpressServer();
  whatsappClient.createClient();
  // 2026-08-03 P0 fix: these three schedulers used to start immediately here,
  // before WhatsApp had even authenticated — their first tick(s) could fire
  // against a client that wasn't ready yet. Gating on onReady means they
  // start as soon as WhatsApp actually connects (fires once, not on every
  // later reconnect — see client.js's onReady for why that's deliberate).
  whatsappClient.onReady(() => {
    cartRecovery.startCartRecoveryScheduler(whatsappClient.sendMessageToChatId);
    deliveryFollowup.startDeliveryFollowupScheduler(whatsappClient.sendMessageToChatId, whatsappClient.buildPhoneToChatIdMap);
    campaignWorker.startCampaignWorker(whatsappClient.sendMessageToChatId);
    // 2026-08-06: on every boot (including a fresh deploy this same feature
    // just triggered), reconcile pending_confirmations.json — finish the
    // "restarting" item's final WhatsApp confirmation once actually healthy,
    // and mark any "drafting" item orphaned by an unrelated restart as
    // draft_failed rather than leaving it stuck forever. A short settle
    // delay so this isn't judged in the same instant WhatsApp connects,
    // before Sheets/embeddings have necessarily finished their own checks.
    setTimeout(() => {
      deploymentAgent
        .reconcileOnBoot(async () => whatsappClient.getStatus() === 'connected' && !googleSheets.isStale())
        .catch((err) => logger.error('deploymentAgent boot reconciliation failed.', err));
    }, 5000);
  });
}

main();
