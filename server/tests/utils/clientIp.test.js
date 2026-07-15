/**
 * S5 — shared client-IP derivation (last-XFF-hop rule).
 *
 * The leftmost X-Forwarded-For hop is client-supplied; nginx appends the
 * real client address as the LAST hop. These tests pin the last-hop rule,
 * the fallback chain, and the IPv6 normalizations for both the socket and
 * HTTP request forms — the same contract as chat-service/core/ipAddress.js
 * and IPBanService.getIPFromSocket.
 */

const { lastForwardedHop, normalizeIp, ipFromSocket, ipFromRequest } = require('../../utils/clientIp');

function makeSocket(headers = {}, address = '10.0.0.9') {
  return {
    handshake: { headers, address },
    conn: { remoteAddress: address },
    request: { connection: { remoteAddress: address } },
  };
}

function makeReq(headers = {}, remoteAddress = '10.0.0.9') {
  return { headers, connection: { remoteAddress }, ip: remoteAddress };
}

describe('lastForwardedHop', () => {
  test('takes the LAST hop of a multi-hop header (spoofed leftmost is ignored)', () => {
    expect(lastForwardedHop('6.6.6.6, 203.0.113.7')).toBe('203.0.113.7');
    expect(lastForwardedHop('a, b , 198.51.100.2 ')).toBe('198.51.100.2');
  });

  test('single hop is returned as-is', () => {
    expect(lastForwardedHop('203.0.113.7')).toBe('203.0.113.7');
  });

  test('absent/empty/non-string values return null', () => {
    expect(lastForwardedHop(undefined)).toBe(null);
    expect(lastForwardedHop('')).toBe(null);
    expect(lastForwardedHop(',,')).toBe(null);
    expect(lastForwardedHop(42)).toBe(null);
  });
});

describe('normalizeIp', () => {
  test('IPv6 localhost forms normalize to 127.0.0.1', () => {
    expect(normalizeIp('::1')).toBe('127.0.0.1');
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
  });

  test('IPv4-in-IPv6 unwraps', () => {
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  test('plain IPv4 passes through', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
  });
});

describe('ipFromSocket', () => {
  test('prefers the last XFF hop over everything', () => {
    const socket = makeSocket({
      'x-forwarded-for': '6.6.6.6, 203.0.113.7',
      'x-real-ip': '198.51.100.9',
    });
    expect(ipFromSocket(socket)).toBe('203.0.113.7');
  });

  test('falls back to x-real-ip, then the transport address', () => {
    expect(ipFromSocket(makeSocket({ 'x-real-ip': '198.51.100.9' }))).toBe('198.51.100.9');
    expect(ipFromSocket(makeSocket({}, '10.0.0.9'))).toBe('10.0.0.9');
  });

  test('normalizes IPv6 forms', () => {
    expect(ipFromSocket(makeSocket({ 'x-forwarded-for': '::ffff:203.0.113.7' }))).toBe('203.0.113.7');
    expect(ipFromSocket(makeSocket({}, '::1'))).toBe('127.0.0.1');
  });

  test('defaults to 127.0.0.1 when nothing is derivable', () => {
    const socket = { handshake: { headers: {}, address: null }, conn: {}, request: {} };
    expect(ipFromSocket(socket)).toBe('127.0.0.1');
  });
});

describe('ipFromRequest', () => {
  test('prefers the last XFF hop', () => {
    expect(ipFromRequest(makeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe('203.0.113.7');
  });

  test('falls back to the socket address, normalized', () => {
    expect(ipFromRequest(makeReq({}, '::ffff:198.51.100.9'))).toBe('198.51.100.9');
  });

  test('regression: the raw multi-hop header is never returned verbatim', () => {
    // The old bug-reports/turnstile readers stored/sent the raw header,
    // which for proxied clients is "spoofed, real" — a comma-joined string.
    const derived = ipFromRequest(makeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }));
    expect(derived).not.toContain(',');
    expect(derived).toBe('203.0.113.7');
  });
});

describe('SessionService.getIpAddress delegates to the last-hop rule', () => {
  test('spoofed leftmost hop no longer keys the session', () => {
    const SessionService = require('../../services/SessionService');
    const sessionService = new SessionService();
    const socket = makeSocket({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' });
    expect(sessionService.getIpAddress(socket)).toBe('203.0.113.7');
  });
});
