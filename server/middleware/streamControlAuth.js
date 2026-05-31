'use strict';

const { safeCompare } = require('../utils/safeCompare');

/**
 * Gate for the stream-control + URL-ingestion routes (`/api/random-stream/*`,
 * `/api/url-stream/*`), which were historically mounted with NO auth — letting
 * any anonymous visitor force-rotate or kill the single live stream, or drive
 * the URL-ingestion (SSRF) path.
 *
 * Accepts EITHER a trusted service-to-service call (`X-Internal-Secret` matching
 * `INTERNAL_API_SECRET`, sent by the chat-service vote handlers) OR a valid
 * admin JWT (the admin UI). Enforcement is gated by `ENFORCE_STREAM_CONTROL_AUTH`
 * so the secret can be rolled out to chat-service BEFORE the server starts
 * rejecting:
 *   - flag OFF (default): permissive — an unauthenticated request is ALLOWED but
 *     logged, so operators can confirm chat-service is sending the secret first.
 *   - flag ON: an unauthenticated request without the secret is handed to
 *     `authenticateAdmin`, which rejects unless a valid admin JWT is present.
 *
 * @param {Function} authenticateAdmin - admin-JWT middleware from middleware/auth
 * @param {{warn: Function}} logger
 * @returns {(req, res, next) => void}
 */
function makeStreamControlAuth(authenticateAdmin, logger) {
  return function streamControlAuth(req, res, next) {
    const expected = process.env.INTERNAL_API_SECRET;
    if (expected && safeCompare(req.headers['x-internal-secret'], expected)) {
      return next();
    }

    if (process.env.ENFORCE_STREAM_CONTROL_AUTH === 'true') {
      return authenticateAdmin(req, res, next);
    }

    // Permissive rollout: allow, but surface unauthenticated calls so the
    // operator can verify the secret is flowing before enforcing.
    if (!req.headers['x-internal-secret'] && !req.headers['authorization']) {
      logger.warn(
        { method: req.method, path: req.originalUrl },
        'stream-control: unauthenticated request ALLOWED (ENFORCE_STREAM_CONTROL_AUTH off)'
      );
    }
    return next();
  };
}

module.exports = { makeStreamControlAuth };
