// Tests for IPBanService.getIPFromSocket (audit M1) — the Socket.IO
// handshake IP derivation must take the LAST X-Forwarded-For hop (the
// nginx-appended real address), not the client-forgeable leftmost one, so
// IP bans hold against header spoofing. Sibling of the chat-service fix in
// chat-service/core/ipAddress.js (audit CH2).

// IPBanService is a singleton that touches the DB at require time
// (constructor loadBannedIPs) and schedules an hourly cleanup interval at
// module scope — mock the database wrapper and use fake timers around the
// require so no real handles leak into jest.
jest.mock('../../database/database', () => ({
  db: {},
  runAsync: jest.fn(async () => ({ changes: 0 })),
  getAsync: jest.fn(async () => undefined),
  allAsync: jest.fn(async () => []),
}));
jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

jest.useFakeTimers();
const IPBanService = require('../../services/IPBanService');

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function fakeSocket(headers = {}, address = '203.0.113.9') {
  return { handshake: { headers, address } };
}

describe('IPBanService.getIPFromSocket (M1: last-XFF-hop)', () => {
  test('takes the LAST X-Forwarded-For hop (nginx-appended)', () => {
    const socket = fakeSocket({ 'x-forwarded-for': '66.66.66.66, 198.51.100.7' });
    expect(IPBanService.getIPFromSocket(socket)).toBe('198.51.100.7');
  });

  test('a banned client spoofing the leftmost hop still resolves to its real IP', () => {
    // Attack from the audit: banned IP forges X-Forwarded-For to look like
    // someone else; nginx appends the real (banned) address last.
    const socket = fakeSocket({ 'x-forwarded-for': 'innocent.example, 10.1.2.3, 198.51.100.66' });
    expect(IPBanService.getIPFromSocket(socket)).toBe('198.51.100.66');
  });

  test('single-hop header unchanged; whitespace trimmed', () => {
    expect(IPBanService.getIPFromSocket(fakeSocket({ 'x-forwarded-for': ' 198.51.100.7 ' }))).toBe('198.51.100.7');
  });

  test('empty header falls back to the handshake address', () => {
    expect(IPBanService.getIPFromSocket(fakeSocket({}, '198.51.100.9'))).toBe('198.51.100.9');
  });

  test('x-real-ip fallback preserved', () => {
    expect(IPBanService.getIPFromSocket(fakeSocket({ 'x-real-ip': '198.51.100.8' }))).toBe('198.51.100.8');
  });

  test('IPv6 normalization preserved (::1, ::ffff: prefix) — including on the last hop', () => {
    expect(IPBanService.getIPFromSocket(fakeSocket({}, '::1'))).toBe('127.0.0.1');
    expect(IPBanService.getIPFromSocket(fakeSocket({}, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
    expect(IPBanService.getIPFromSocket(fakeSocket({ 'x-forwarded-for': '66.66.66.66, ::ffff:198.51.100.11' }))).toBe('198.51.100.11');
  });
});
