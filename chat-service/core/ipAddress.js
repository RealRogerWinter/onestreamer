// Client-IP derivation for chat-service Socket.IO handshakes (audit CH2).
//
// Socket.IO handshake reads bypass Express `trust proxy`, so the
// X-Forwarded-For parse must be done by hand. The OLD code took the FIRST
// (leftmost) comma-separated hop — which is client-supplied and therefore
// spoofable: one person could mint unlimited anonymous identities, pass any
// vote alone (vote dedup keys on this IP), inflate the unique-IP viewer
// denominator, and evade IP bans.
//
// nginx APPENDS the real client address as the LAST hop
// ($proxy_add_x_forwarded_for — see nginx/onestreamer.example.conf), so the
// last hop is the only trustworthy one. PRECONDITIONS (operator):
//   - exactly ONE trusted proxy (nginx) in front of the service — if a CDN
//     is ever added, this must become a hop-count parse;
//   - the chat port is NOT directly reachable bypassing nginx
//     (BIND_ADDR=127.0.0.1 in production — see the warning in index.js),
//     otherwise even the last hop is attacker-controlled.
//
// The same fix exists server-side in server/services/IPBanService.js
// (getIPFromSocket, audit M1) — duplicated because the two processes are
// separate packages and do not share code.

/**
 * Return the LAST comma-separated hop of an X-Forwarded-For value (the
 * nginx-appended real client address), or null when the header is absent
 * or empty.
 *
 * @param {unknown} xff raw header value
 * @returns {string|null}
 */
function lastForwardedHop(xff) {
  if (typeof xff !== 'string' || xff.length === 0) return null;
  const hops = xff.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

/**
 * Get the client IP address from a Socket.IO socket. Prefers the last
 * X-Forwarded-For hop, then X-Real-IP (nginx-set), then the transport
 * address. Normalizes IPv6 localhost and IPv4-in-IPv6 (`::ffff:`) forms —
 * unchanged from the pre-CH2 behavior.
 *
 * @param {object} socket Socket.IO socket
 * @returns {string}
 */
function getIpAddress(socket) {
  let ip = lastForwardedHop(socket.handshake.headers['x-forwarded-for']) ||
           socket.handshake.headers['x-real-ip'] ||
           socket.handshake.address ||
           socket.conn.remoteAddress ||
           socket.request.connection.remoteAddress ||
           '127.0.0.1';

  // Handle IPv6 localhost
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  }

  // Extract IPv4 from IPv6 format if needed
  if (ip.includes('::ffff:')) {
    ip = ip.replace('::ffff:', '');
  }

  return ip;
}

module.exports = { getIpAddress, lastForwardedHop };
