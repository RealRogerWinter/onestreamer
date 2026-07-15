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
// NOTE on defaults (unified 2026-07-15, audit follow-up): call sites used
// to carry three divergent CHAT_SERVICE_URL fallbacks —
// 'https://onestreamer.live:8444' (public FQDN, admin-moderation.js),
// 'https://127.0.0.1:8444' (loopback, most sites), and the outright wrong
// 'http://127.0.0.1:8081' (SoundFxService — chat-service has never listened
// there, so dev-host TTS announcements silently failed without the env
// set). All call sites now share DEFAULT_CHAT_SERVICE_URL below: loopback,
// which keeps the X-Internal-Secret header off the public hop. In
// production CHAT_SERVICE_URL is set (compose.yaml: https://127.0.0.1:8444)
// so the default only matters on dev hosts.

const https = require('https');

// Single shared agent for the self-signed local chat-service cert (matches
// the rejectUnauthorized:false agents the call sites built inline; sharing
// one instance avoids a new TLS agent per request).
const selfSignedAgent = new https.Agent({ rejectUnauthorized: false });

const DEFAULT_CHAT_SERVICE_URL = 'https://127.0.0.1:8444';

/**
 * Resolve the chat-service base URL: CHAT_SERVICE_URL env, else the
 * unified loopback default (see NOTE above).
 *
 * @param {string} [defaultUrl] override fallback (rarely needed)
 * @returns {string}
 */
function chatServiceUrl(defaultUrl = DEFAULT_CHAT_SERVICE_URL) {
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
