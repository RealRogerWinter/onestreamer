'use strict';

// Shared axios-config helper for main-server → chat-service HTTP calls
// (audit CH3, Plan 06). Every outbound call to the chat-service HTTP API
// (/api/ban, /api/unban, /api/timeout, /api/remove-timeout,
// /api/system-message, /api/moderation, /api/chat-history) must attach the
// X-Internal-Secret header so the chat-service's internalAuth middleware
// (chat-service/api/internalAuth.js) can authenticate the caller once
// ENFORCE_CHAT_INTERNAL_AUTH is flipped on. Mirrors the chat-service's own
// getAxiosConfig (chat-service/index.js) which does the same in the
// opposite direction (chat → main, verified by streamControlAuth).
//
// NOTE on defaults: the pre-existing call sites carry two divergent
// CHAT_SERVICE_URL fallbacks — 'https://onestreamer.live:8444' (public FQDN,
// admin-moderation.js) vs 'https://127.0.0.1:8444' (loopback, everywhere
// else) and 'http://127.0.0.1:8081' (SoundFxService). This helper
// deliberately PRESERVES the per-call-site default via the `defaultUrl`
// parameter rather than unifying them — unification (presumably on
// 127.0.0.1, keeping secret-bearing traffic off the public hop) is a
// follow-up decision for the maintainer. In production CHAT_SERVICE_URL is
// set (compose.yaml: https://127.0.0.1:8444) so the defaults only matter
// on dev hosts.

const https = require('https');

// Single shared agent for the self-signed local chat-service cert (matches
// the rejectUnauthorized:false agents the call sites built inline; sharing
// one instance avoids a new TLS agent per request).
const selfSignedAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Resolve the chat-service base URL: CHAT_SERVICE_URL env, else the
 * call site's historical default.
 *
 * @param {string} defaultUrl per-call-site fallback (see NOTE above)
 * @returns {string}
 */
function chatServiceUrl(defaultUrl) {
  return process.env.CHAT_SERVICE_URL || defaultUrl;
}

/**
 * Build the axios config for a chat-service call: 5s timeout (overridable),
 * the shared self-signed-tolerant agent when the target is https, and the
 * X-Internal-Secret header when INTERNAL_API_SECRET is configured.
 *
 * @param {string} url    full URL or base URL (only the scheme is inspected)
 * @param {object} [extra] additional axios config (params, headers, timeout,
 *                         httpsAgent — caller-supplied values win)
 * @returns {object} axios request config
 */
function chatAxiosConfig(url, extra = {}) {
  const { headers, ...rest } = extra;
  const config = { timeout: 5000, ...rest };
  if (typeof url === 'string' && url.startsWith('https') && !config.httpsAgent) {
    config.httpsAgent = selfSignedAgent;
  }
  const mergedHeaders = { ...(headers || {}) };
  const secret = process.env.INTERNAL_API_SECRET;
  if (secret) {
    mergedHeaders['X-Internal-Secret'] = secret;
  }
  if (Object.keys(mergedHeaders).length > 0) {
    config.headers = mergedHeaders;
  }
  return config;
}

module.exports = { chatServiceUrl, chatAxiosConfig };
