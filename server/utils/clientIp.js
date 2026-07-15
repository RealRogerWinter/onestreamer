// Client-IP derivation for the main server (audit S5).
//
// The X-Forwarded-For header is client-supplied except for the hop nginx
// APPENDS ($proxy_add_x_forwarded_for) — the LAST one. The OLD readers in
// SessionService/TimeTrackingService/turnstile/bug-reports took the raw
// header or its FIRST hop, letting a client spoof any IP: mint session
// identities, evade the (already-fixed) IP-ban derivation by disagreeing
// with it, skew time-tracking identities, and attribute bug reports /
// Turnstile verifications to arbitrary addresses.
//
// PRECONDITIONS (operator — same as IPBanService.getIPFromSocket and
// chat-service/core/ipAddress.js):
//   - exactly ONE trusted proxy (nginx) in front of the app — if a CDN is
//     ever added, this must become a hop-count parse;
//   - the app ports are NOT directly reachable bypassing nginx
//     (BIND_ADDR=127.0.0.1 in production), otherwise even the last hop is
//     attacker-controlled.
//
// Express `trust proxy` is deliberately NOT used here: the socket readers
// are Socket.IO handshakes (trust proxy never applies), and the HTTP
// readers use the same helper so both derive identically.

/**
 * Return the LAST comma-separated hop of an X-Forwarded-For value (the
 * nginx-appended real client address), or null when absent/empty.
 *
 * @param {unknown} xff raw header value
 * @returns {string|null}
 */
function lastForwardedHop(xff) {
  if (typeof xff !== 'string' || xff.length === 0) return null;
  const hops = xff.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

/** Normalize IPv6-localhost and IPv4-in-IPv6 (`::ffff:`) forms. */
function normalizeIp(ip) {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    return '127.0.0.1';
  }
  if (typeof ip === 'string' && ip.includes('::ffff:')) {
    return ip.replace('::ffff:', '');
  }
  return ip;
}

/**
 * Client IP from a Socket.IO socket: last X-Forwarded-For hop, then
 * X-Real-IP (nginx-set), then the transport address.
 *
 * @param {object} socket Socket.IO socket
 * @returns {string}
 */
function ipFromSocket(socket) {
  const ip = lastForwardedHop(socket.handshake.headers['x-forwarded-for']) ||
             socket.handshake.headers['x-real-ip'] ||
             socket.handshake.address ||
             socket.conn?.remoteAddress ||
             socket.request?.connection?.remoteAddress ||
             '127.0.0.1';
  return normalizeIp(ip);
}

/**
 * Client IP from an Express request: last X-Forwarded-For hop, then the
 * socket address.
 *
 * @param {object} req Express request
 * @returns {string}
 */
function ipFromRequest(req) {
  const ip = lastForwardedHop(req.headers['x-forwarded-for']) ||
             req.connection?.remoteAddress ||
             req.ip ||
             '127.0.0.1';
  return normalizeIp(ip);
}

module.exports = { lastForwardedHop, normalizeIp, ipFromSocket, ipFromRequest };
