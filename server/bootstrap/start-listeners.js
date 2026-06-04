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
  // Bind address seam: production sets BIND_ADDR=127.0.0.1 so nginx is the
  // sole ingress (the app runs on the host network behind nginx — ADR-0025).
  // Defaults to '0.0.0.0' to preserve the original behaviour when unset.
  const bindAddr = process.env.BIND_ADDR || '0.0.0.0';

  // Defense-in-depth (ADR-0025): in production the app must sit behind nginx on
  // loopback. Warn loudly if bound to a routable interface — under host
  // networking there is no container port-isolation backstop.
  if (process.env.NODE_ENV === 'production' && !['127.0.0.1', '::1', 'localhost'].includes(bindAddr)) {
    logger.warn(`⚠️  SECURITY: binding ${bindAddr} (non-loopback) in production — set BIND_ADDR=127.0.0.1 so nginx is the sole ingress; never open 8443/8444/8081 in the firewall.`);
  }

  if (httpsServer) {
    httpsServer.on('error', (err) => {
      logger.error({ err, bindAddr, httpsPort }, '❌ HTTPS listener error (e.g. address in use) — exiting');
      process.exit(1);
    });
    // HTTPS configured (production): serve ONLY over TLS. The plain-HTTP
    // listener is intentionally skipped here — once HTTPS is on, Socket.IO
    // and the Express app are served via httpsServer (see index.js
    // `const server = httpsServer || httpServer`), so the HTTP listener is
    // dead weight. Worse, under the host network it would collide with the
    // livekit-ingress WHIP server already bound to :8080 (ADR-0025).
    httpsServer.listen(httpsPort, bindAddr, () => {
      logger.debug(`🔒 HTTPS server running on port ${httpsPort} (bind ${bindAddr})`);
      logger.debug('🔍 HTTPS Server accessible on:');
      logger.debug('  - https://localhost:' + httpsPort);
      logger.debug('  - https://onestreamer.live:' + httpsPort);
      logger.debug('⚠️  Note: Using self-signed certificate. Browser will show security warning.');
    });
  } else {
    // No HTTPS (local dev): plain HTTP is the only listener.
    httpServer.listen(port, bindAddr, () => {
      logger.debug(`🌐 HTTP server running on port ${port} (bind ${bindAddr})`);
      logger.debug(`Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.debug('🔍 HTTP Server accessible on:');
      logger.debug('  - http://localhost:' + port);
      logger.debug('  - http://onestreamer.live:' + port);
    });
  }
};
