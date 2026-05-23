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
        ANNOUNCED_IP: '<SERVER_IP>',
        TURN_DOMAIN: 'turn.onestreamer.live',
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
    },
    {
      name: 'onestreamer-client',
      script: 'npm',
      args: 'start',
      cwd: '/root/onestreamer/client',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '2G',
      env: {
        NODE_ENV: 'production',
        REACT_APP_SERVER_URL: 'https://onestreamer.live',
        REACT_APP_API_URL: 'https://onestreamer.live',
        REACT_APP_CHAT_SERVER_URL: 'https://onestreamer.live',
        HTTPS: 'true',
        SSL_CRT_FILE: '../certificates/react-cert.pem',
        SSL_KEY_FILE: '../certificates/react-key.pem',
        PORT: 3443,
        DANGEROUSLY_DISABLE_HOST_CHECK: 'true',
        HOST: '0.0.0.0',
        WDS_SOCKET_HOST: 'onestreamer.live',
        WDS_SOCKET_PORT: 443
      },
      error_file: '../logs/client-error.log',
      out_file: '../logs/client-out.log',
      log_file: '../logs/client-combined.log',
      time: true
    }
  ]
};