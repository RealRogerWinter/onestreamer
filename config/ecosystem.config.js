module.exports = {
  apps: [
    {
      name: 'onestreamer-server',
      script: './server/index.js',
      cwd: '/root/onestreamer',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        HTTPS_PORT: 8443,
        USE_HTTPS: 'true',
        CLIENT_URL: 'https://onestreamer.live',
        CHAT_SERVICE_URL: 'https://127.0.0.1:8444',
        MAIN_SERVER_URL: 'https://127.0.0.1:8443',
        SERVER_HOST: 'onestreamer.live',
        VIEWBOT_SERVER_URL: 'https://127.0.0.1:8443',
        ANNOUNCED_IP: process.env.ANNOUNCED_IP || '',
        TURN_DOMAIN: 'turn.onestreamer.live',
        // Skip ffmpeg re-encode for direct HLS sources (already H.264/AAC). Drops the
        // viewbot ffmpeg from ~40% to ~5% of one core. Roll back by setting to 'false'
        // if a platform changes its encoder or subscriber freeze-on-join becomes an issue.
        VIEWBOT_STREAM_COPY: 'true',
        // Email configuration — SMTP_PASS must be set in server/.env (never committed).
        // SMTP_HOST/PORT/SECURE/USER/FROM_EMAIL are also expected from server/.env.
      },
      error_file: './logs/server-error.log',
      out_file: './logs/server-out.log',
      log_file: './logs/server-combined.log',
      time: true
    },
    {
      name: 'onestreamer-chat',
      script: './chat-service/index.js',
      cwd: '/root/onestreamer',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 8081,
        CHAT_PORT: 8081,
        CHAT_HTTPS_PORT: 8444,
        USE_HTTPS: 'true',
        CLIENT_URL: 'https://onestreamer.live',
        MAIN_SERVER_URL: 'https://127.0.0.1:8443',
        SERVER_HOST: 'onestreamer.live'
      },
      error_file: './logs/chat-error.log',
      out_file: './logs/chat-out.log',
      log_file: './logs/chat-combined.log',
      time: true
    }
    // onestreamer-client (CRA dev server) disabled 2026-05-26: nginx serves the
    // built bundle from /var/www/html; the dev server was crash-looping (~59 restarts)
    // and consuming ~1.2 GB RAM for no benefit. To re-enable for local debugging,
    // restore from ecosystem.config.js.bak-* and `pm2 start ecosystem.config.js`.
    //
    // IMPORTANT: with the dev server gone, /var/www/html only updates when a
    // built bundle is rsynced there. scripts/deploy/start-production.sh handles
    // this. For incremental deploys without the full restart, run:
    //   cd client && npm run build
    //   sudo rsync -a --no-owner --no-group client/build/ /var/www/html/
    // See docs/operations/runbooks/stale-frontend-after-deploy.md.
  ]
};