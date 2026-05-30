'use strict';

const crypto = require('crypto');

/**
 * Constant-time comparison for shared secrets (admin keys, internal secrets).
 *
 * Both inputs are hashed to a fixed-length SHA-256 digest before comparison so
 * that neither the length nor the content of `expected` leaks via timing or via
 * timingSafeEqual's equal-length precondition. Fails closed on missing, blank,
 * or non-string input.
 *
 * @param {unknown} provided value supplied by the caller (e.g. a request header)
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

module.exports = { safeCompare };
