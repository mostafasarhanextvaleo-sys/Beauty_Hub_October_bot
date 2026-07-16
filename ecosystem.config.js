module.exports = {
  apps: [
    {
      name: 'beauty-hub-bot',
      script: 'src/index.js',
      cwd: __dirname,
      // pm2's default kill_timeout (1600ms) fires before whatsapp-web.js's
      // puppeteer/Chrome subprocess can close cleanly, which is what leaves
      // its session lock behind for the next restart to hang on. The
      // SIGTERM handler in src/index.js bounds its own shutdown to 7s, so
      // this just needs to be comfortably longer than that.
      kill_timeout: 10000,
    },
    {
      // Separate process from beauty-hub-bot on purpose — see the design
      // note at the top of scripts/testRunner.js. Never touches the real
      // WhatsApp client, only calls agent.handleMessage() directly.
      name: 'test-runner',
      script: 'scripts/testRunner.js',
      args: '--loop',
      cwd: __dirname,
      autorestart: true,
    },
  ],
};
