// Internal-secret gate for the chat-service HTTP API (audit CH3, Plan 06).
//
// The chat HTTP API historically had NO auth — it trusted "the main server
// is the only caller and reaches us over private networking". That left
// /api/ban, /api/unban, /api/timeout, /api/remove-timeout,
// /api/system-message (mutations) plus /api/moderation and /api/chat-history
// (data leaks) open to anyone who can reach port 8444. This middleware
// requires the same X-Internal-Secret header the chat-service itself already
// sends on chat→main calls (getAxiosConfig, chat-service/index.js), matched
// against INTERNAL_API_SECRET.
//
// Rollout semantics mirror the proven server-side streamControlAuth pattern
// (server/middleware/streamControlAuth.js, the S3 fix):
//   - header matches INTERNAL_API_SECRET            → allow.
//   - else, ENFORCE_CHAT_INTERNAL_AUTH === 'true'   → 401 JSON.
//   - else (permissive rollout phase, the default)  → ALLOW but warn-log,
//     so operators can confirm the main server is sending the secret on all
//     ~13 outbound call sites (server/utils/chatServiceClient.js) BEFORE
//     flipping enforcement on.
//
// Operator sequence: set INTERNAL_API_SECRET on both processes → deploy →
// watch the 'ALLOWED (unauthenticated)' warn go silent → set
// ENFORCE_CHAT_INTERNAL_AUTH=true on the chat-service.
//
// /health is deliberately NOT gated (container healthchecks hit it).

const crypto = require('crypto');

/**
 * Constant-time comparison for shared secrets. Copy of
 * server/utils/safeCompare.js — chat-service is a separate package and must
 * not require() across the package boundary into server/.
 *
 * Both inputs are hashed to a fixed-length SHA-256 digest before comparison
 * so that neither the length nor the content of `expected` leaks via timing
 * or via timingSafeEqual's equal-length precondition. Fails closed on
 * missing, blank, or non-string input.
 *
 * @param {unknown} provided value supplied by the caller (request header)
 * @param {unknown} expected the configured secret to compare against
 * @returns {boolean} true iff both are non-empty strings and equal
 */
function safeCompare(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Express middleware — see the file header for the exact semantics.
 * Reads process.env at request time (not module load) so tests and
 * operators can flip the flag without a re-require.
 */
function internalAuth(req, res, next) {
  const expected = process.env.INTERNAL_API_SECRET;
  if (expected && safeCompare(req.headers['x-internal-secret'], expected)) {
    return next();
  }

  if (process.env.ENFORCE_CHAT_INTERNAL_AUTH === 'true') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Permissive rollout: allow, but surface unauthenticated calls so the
  // operator can verify the secret is flowing before enforcing.
  console.warn(
    `⚠️ CHAT AUTH: unauthenticated ${req.method} ${req.originalUrl} ALLOWED (ENFORCE_CHAT_INTERNAL_AUTH off)`
  );
  return next();
}

module.exports = { internalAuth, safeCompare };
