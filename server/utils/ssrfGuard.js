'use strict';

const net = require('net');
const dns = require('dns').promises;

/**
 * True if `ip` (a valid IPv4/IPv6 literal) is in a private, loopback,
 * link-local, or otherwise non-public/reserved range — the things an
 * SSRF attacker would point a URL at (cloud metadata, internal services…).
 */
function isPrivateOrReservedIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return (
      p[0] === 0 ||                                   // 0.0.0.0/8 "this network"
      p[0] === 10 ||                                  // 10.0.0.0/8
      p[0] === 127 ||                                 // 127.0.0.0/8 loopback
      (p[0] === 169 && p[1] === 254) ||               // 169.254.0.0/16 link-local (cloud metadata)
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||   // 172.16.0.0/12
      (p[0] === 192 && p[1] === 168) ||               // 192.168.0.0/16
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||  // 100.64.0.0/10 CGNAT
      p[0] >= 224                                     // 224/4 multicast + 240/4 reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;                                  // loopback / unspecified
    if (/^fe[89ab]/.test(v)) return true;                                        // fe80::/10 link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true;                   // fc00::/7 unique-local
    if (v.startsWith('::ffff:')) return true;                                    // IPv4-mapped — block conservatively
    return false;
  }
  return false;
}

/**
 * Throws if `url` is not an http(s) URL, or targets a private/reserved address
 * directly or via DNS resolution. This blocks the direct-IP and DNS-rebind SSRF
 * vectors (e.g. `http://169.254.169.254/…`, `http://127.0.0.1:8443/…`).
 *
 * It does NOT stop redirect-based SSRF — `streamlink`/`yt-dlp` follow redirects
 * themselves — so complete protection still needs network-level egress
 * filtering. `lookup` is injectable for testing.
 */
async function assertSafeUrl(url, { lookup = dns.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error('Blocked: URL targets a private or reserved address');
    }
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Blocked: URL targets localhost');
  }
  let addrs;
  try {
    addrs = await lookup(host, { all: true });
  } catch (_) {
    throw new Error('Blocked: hostname did not resolve');
  }
  for (const { address } of addrs) {
    if (isPrivateOrReservedIp(address)) {
      throw new Error('Blocked: hostname resolves to a private or reserved address');
    }
  }
}

module.exports = { assertSafeUrl, isPrivateOrReservedIp };
