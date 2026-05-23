// Time-limited TURN credentials endpoint.
//
// Historically the client mint these credentials itself by HMAC-signing
// `<expiry>:<identity>` with the coturn static-auth-secret. That secret was
// shipped in the React bundle and thus public to every browser visitor.
//
// This endpoint moves the signing server-side. The client fetches a fresh
// credential bundle at session start; the secret stays in `process.env.TURN_SECRET`
// only. See ADR / security audit for context.
//
// Format follows the coturn `use-auth-secret` (time-limited) pattern:
//   username   = `<unix-expiry>:<identity>`
//   credential = base64(HMAC-SHA1(username, TURN_SECRET))
// coturn validates by recomputing the HMAC with the same shared secret.

const express = require('express');
const crypto = require('crypto');
const requireEnv = require('../config/requireEnv');

const router = express.Router();

// Read at module load so the server fails fast if TURN_SECRET is unset.
// No source-tree fallback — a known default would defeat the whole point.
const TURN_SECRET = requireEnv('TURN_SECRET');

// 10 minute TTL: short enough that a leaked credential is mostly useless,
// long enough to establish a session. WebRTC consent freshness keeps an
// already-established peer connection working past the TTL.
const TURN_TTL_SECONDS = 10 * 60;

// Prefer the public IP (bypasses Cloudflare-style proxies that don't forward
// UDP/TURN). Falls back to TURN_DOMAIN, then localhost for dev.
const TURN_HOST =
  process.env.ANNOUNCED_IP ||
  process.env.TURN_DOMAIN ||
  '127.0.0.1';

router.get('/credentials', (req, res) => {
  // Identity is only used in the TURN-server logs — not as auth. Anonymous
  // viewers are fine; the HMAC is what authenticates against coturn.
  const identity = req.user?.username || req.user?.id || 'viewer';

  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS;
  const username = `${expiry}:${identity}`;
  const credential = crypto
    .createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');

  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: `turn:${TURN_HOST}:3478`, username, credential },
      { urls: `turn:${TURN_HOST}:3478?transport=tcp`, username, credential }
    ],
    ttl: TURN_TTL_SECONDS
  });
});

module.exports = router;
