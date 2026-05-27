const { createProxyMiddleware } = require('http-proxy-middleware');

// Use environment variables with fallback to local IP for internal communication
const MAIN_SERVER_URL = process.env.REACT_APP_API_URL || 'https://127.0.0.1:8443';
const CHAT_SERVER_URL = process.env.REACT_APP_CHAT_SERVER_URL || 'https://127.0.0.1:8444';

// Parse URLs to use IP for internal communication
const mainServerTarget = MAIN_SERVER_URL.replace('onestreamer.live', '127.0.0.1');
const chatServerTarget = CHAT_SERVER_URL.replace('onestreamer.live', '127.0.0.1');

module.exports = function(app) {
  // Proxy for main backend API
  app.use(
    '/api',
    createProxyMiddleware({
      target: mainServerTarget,
      changeOrigin: true,
      secure: false,
      ws: false
    })
  );

  // Proxy for auth endpoints - but NOT auth/success and auth/error which are React routes
  app.use(
    '/auth',
    createProxyMiddleware({
      target: mainServerTarget,
      changeOrigin: true,
      secure: false,
      headers: {
        'Connection': 'keep-alive'
      },
      // Filter function to exclude client-side routes
      filter: function(pathname, req) {
        // Don't proxy these paths - let React handle them
        const clientRoutes = ['/auth/success', '/auth/error'];
        return !clientRoutes.some(route => pathname.startsWith(route));
      }
    })
  );

  // Proxy for admin endpoints
  app.use(
    '/admin',
    createProxyMiddleware({
      target: mainServerTarget,
      changeOrigin: true,
      secure: false,
      ws: false
    })
  );

  // Proxy for socket.io
  app.use(
    '/socket.io',
    createProxyMiddleware({
      target: mainServerTarget,
      changeOrigin: true,
      secure: false,
      ws: true
    })
  );

  // Proxy for chat socket.io
  app.use(
    '/chat/socket.io',
    createProxyMiddleware({
      target: chatServerTarget,
      changeOrigin: true,
      secure: false,
      ws: true,
      pathRewrite: {
        '^/chat': ''
      }
    })
  );

  // Proxy for uploads
  app.use(
    '/uploads',
    createProxyMiddleware({
      target: mainServerTarget,
      changeOrigin: true,
      secure: false
    })
  );

  // Proxy for health checks
  app.use(
    '/health',
    createProxyMiddleware({
      target: mainServerTarget,
      changeOrigin: true,
      secure: false
    })
  );

  // Proxy for other debug endpoints
  app.use(
    '/debug',
    createProxyMiddleware({
      target: mainServerTarget,
      changeOrigin: true,
      secure: false
    })
  );
};