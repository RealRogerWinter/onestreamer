// Tests for chat-service/core/ipAddress.js (audit CH2) — the client-IP
// derivation for Socket.IO handshakes must take the LAST X-Forwarded-For
// hop (the nginx-appended real address), not the client-forgeable leftmost
// one, while preserving the pre-existing IPv6 normalization.

const { getIpAddress, lastForwardedHop } = require('../../core/ipAddress');

function fakeSocket({ headers = {}, address = '203.0.113.9' } = {}) {
  return {
    handshake: { headers, address },
    conn: { remoteAddress: address },
    request: { connection: { remoteAddress: address } },
  };
}

describe('lastForwardedHop', () => {
  test('returns the LAST hop of a multi-hop header', () => {
    expect(lastForwardedHop('1.2.3.4, 5.6.7.8, 9.10.11.12')).toBe('9.10.11.12');
  });

  test('single hop returned unchanged', () => {
    expect(lastForwardedHop('5.6.7.8')).toBe('5.6.7.8');
  });

  test('trims whitespace and ignores empty trailing segments', () => {
    expect(lastForwardedHop('1.2.3.4 ,  5.6.7.8 , ')).toBe('5.6.7.8');
  });

  test('null/absent/empty header → null', () => {
    expect(lastForwardedHop(undefined)).toBeNull();
    expect(lastForwardedHop(null)).toBeNull();
    expect(lastForwardedHop('')).toBeNull();
    expect(lastForwardedHop(' , ')).toBeNull();
  });
});

describe('getIpAddress', () => {
  test('spoofed leftmost XFF hop is IGNORED — the nginx-appended last hop wins', () => {
    // The attack from the audit: client sends its own X-Forwarded-For to
    // mint a fresh identity / evade an IP ban; nginx appends the real
    // address as the final hop.
    const socket = fakeSocket({
      headers: { 'x-forwarded-for': '66.66.66.66, 198.51.100.7' },
    });
    expect(getIpAddress(socket)).toBe('198.51.100.7');
  });

  test('single-hop XFF unchanged', () => {
    const socket = fakeSocket({ headers: { 'x-forwarded-for': '198.51.100.7' } });
    expect(getIpAddress(socket)).toBe('198.51.100.7');
  });

  test('falls back to x-real-ip, then the transport address', () => {
    expect(getIpAddress(fakeSocket({ headers: { 'x-real-ip': '198.51.100.8' } }))).toBe('198.51.100.8');
    expect(getIpAddress(fakeSocket({ headers: {}, address: '198.51.100.9' }))).toBe('198.51.100.9');
  });

  test('IPv6 localhost normalized to 127.0.0.1', () => {
    expect(getIpAddress(fakeSocket({ headers: {}, address: '::1' }))).toBe('127.0.0.1');
    expect(getIpAddress(fakeSocket({ headers: {}, address: '::ffff:127.0.0.1' }))).toBe('127.0.0.1');
  });

  test('IPv4-in-IPv6 prefix stripped — including on the last XFF hop', () => {
    expect(getIpAddress(fakeSocket({ headers: {}, address: '::ffff:198.51.100.10' }))).toBe('198.51.100.10');
    const socket = fakeSocket({
      headers: { 'x-forwarded-for': '66.66.66.66, ::ffff:198.51.100.11' },
    });
    expect(getIpAddress(socket)).toBe('198.51.100.11');
  });
});
