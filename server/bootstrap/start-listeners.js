/**
 * HTTP / HTTPS listener startup helper.
 *
 * Pulled out of `server/index.js` startServer() body in PR 4.3 as part of
 * the orchestrator decomposition. Each `<server>.listen(port, host,
 * callback)` call was 7-8 lines of boilerplate console.log inline; the
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
    console.log(`🌐 HTTP server running on port ${port}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('🔍 HTTP Server accessible on:');
    console.log('  - http://localhost:' + port);
    console.log('  - http://onestreamer.live:' + port);
  });

  if (httpsServer) {
    httpsServer.listen(httpsPort, '0.0.0.0', () => {
      console.log(`🔒 HTTPS server running on port ${httpsPort}`);
      console.log('🔍 HTTPS Server accessible on:');
      console.log('  - https://localhost:' + httpsPort);
      console.log('  - https://onestreamer.live:' + httpsPort);
      console.log('⚠️  Note: Using self-signed certificate. Browser will show security warning.');
    });
  }
};
