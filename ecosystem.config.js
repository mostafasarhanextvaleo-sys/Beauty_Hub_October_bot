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
      // 2026-08-02: this machine sits behind a home/office router with no
      // inbound port forwarding (confirmed — nginx/node both listen fine
      // locally, but the public IP refuses external connections on both 80
      // and 3000). ngrok makes an outbound-only connection instead, so it
      // works regardless of router/NAT/CGNAT config. Points at nginx (port
      // 80), which already proxies /invoice and /health to the bot — see
      // /etc/nginx/sites-available/beautyhub. PM2-managed (not a bare
      // background process) so it survives crashes and reboots the same way
      // the bot itself does.
      // TEMPORARY: running without --url=<static-domain> means ngrok
      // assigns a NEW RANDOM *.ngrok-free.dev hostname every time this
      // process restarts (crash, `pm2 restart`, reboot) — every invoice
      // link already sent/printed before that breaks. Claim the account's
      // one free static domain at dashboard.ngrok.com -> Domains, then add
      // `--url=https://<that-domain>` to args below and this stops rotating
      // for good. Owner was mid-task on this as of 2026-08-02.
      name: 'invoice-tunnel',
      script: '/snap/bin/ngrok',
      args: 'http 80 --log=stdout',
      autorestart: true,
    },
  ],
};
