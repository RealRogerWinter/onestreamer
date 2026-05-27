const logger = require('./logger').child({ svc: 'start-listeners' });

/**
 * HTTP / HTTPS listener startup helper.
 *
 * Pulled out of `server/index.js` startServer() body in PR 4.3 as part of
 * the orchestrator decomposition. Each `<server>.listen(port, host,
 * callback)` call was 7-8 lines of boilerplate log lines inline; the
 * combined block plus the surrounding `if (httpsServer)` branch was ~20
 * lines that have nothing to do with the rest of startServer's
 * service-wiring work.
 *
 * Behaviour-equivalent to the original inline block: same ports, same
 * `'0.0.0.0'` host binding, same log lines, same conditional on `httpsServer`.
 * The `httpServer.on('error', ...)` handler from the same neighborhood is
 * **deliberately left inline** in server/index.js because it's a long-lived
 * runtime concern, not a startup concern — moving it here would imply the
 * helper owns the lifecycle.
 *
 * `deps`:
 *   - httpServer   The Node http.Server instance. Required.
 *   - httpsServer  The Node https.Server instance, or `null` if HTTPS isn't
 *                  configured. Optional; the HTTPS branch is skipped when
 *                  null.
 *   - port         The HTTP port. Required.
 *   - httpsPort    The HTTPS port. Required when httpsServer is present.
 */
module.exports = function startListeners({ httpServer, httpsServer, port, httpsPort }) {
  httpServer.listen(port, '0.0.0.0', () => {
    logger.debug(`🌐 HTTP server running on port ${port}`);
    logger.debug(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.debug('🔍 HTTP Server accessible on:');
    logger.debug('  - http://localhost:' + port);
    logger.debug('  - http://onestreamer.live:' + port);
  });

  if (httpsServer) {
    httpsServer.listen(httpsPort, '0.0.0.0', () => {
      logger.debug(`🔒 HTTPS server running on port ${httpsPort}`);
      logger.debug('🔍 HTTPS Server accessible on:');
      logger.debug('  - https://localhost:' + httpsPort);
      logger.debug('  - https://onestreamer.live:' + httpsPort);
      logger.debug('⚠️  Note: Using self-signed certificate. Browser will show security warning.');
    });
  }
};
