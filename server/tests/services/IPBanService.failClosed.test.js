// Tests for audit M6: IPBanService.isIPBanned must fail CLOSED on a DB
// error in BOTH branches. The cache-hit verify branch already returned
// true (deny) when the DB check threw; the uncached branch returned false
// (allow) — letting a banned IP connect/stream during any DB hiccup. Both
// callers (server/bootstrap/register-socket-handlers.js connection gate,
// server/sockets/streamHandler/takeover.js request-to-stream gate) treat
// `true` as banned/deny.

// IPBanService is a singleton that touches the DB at require time
// (constructor loadBannedIPs) and schedules an hourly cleanup interval at
// module scope — mock the database wrapper and use fake timers around the
// require so no real handles leak into jest.
jest.mock('../../database/database', () => ({
  db: {},
  runAsync: jest.fn(async () => ({ changes: 0 })),
  getAsync: jest.fn(async () => ({ count: 0 })),
  allAsync: jest.fn(async () => []),
}));
jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

jest.useFakeTimers();
const { getAsync } = require('../../database/database');
const IPBanService = require('../../services/IPBanService');

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

beforeEach(() => {
  getAsync.mockReset();
  IPBanService.bannedIPs.clear();
});

describe('IPBanService.isIPBanned fail-closed (M6)', () => {
  test('uncached IP + DB error → treated as banned (deny)', async () => {
    getAsync.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
    await expect(IPBanService.isIPBanned('198.51.100.20')).resolves.toBe(true);
  });

  test('cached IP + DB error → still treated as banned (existing branch unchanged)', async () => {
    IPBanService.bannedIPs.add('198.51.100.21');
    getAsync.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
    await expect(IPBanService.isIPBanned('198.51.100.21')).resolves.toBe(true);
  });

  test('uncached IP + healthy DB says not banned → allowed (no false positives)', async () => {
    getAsync.mockResolvedValue({ count: 0 });
    await expect(IPBanService.isIPBanned('198.51.100.22')).resolves.toBe(false);
  });

  test('uncached IP + healthy DB says banned → banned, and cache is updated', async () => {
    getAsync.mockResolvedValue({ count: 1 });
    await expect(IPBanService.isIPBanned('198.51.100.23')).resolves.toBe(true);
    expect(IPBanService.bannedIPs.has('198.51.100.23')).toBe(true);
  });

  test('missing IP is never banned (guard clause unchanged, DB not consulted)', async () => {
    getAsync.mockRejectedValue(new Error('should not be called'));
    await expect(IPBanService.isIPBanned(null)).resolves.toBe(false);
    await expect(IPBanService.isIPBanned('')).resolves.toBe(false);
    expect(getAsync).not.toHaveBeenCalled();
  });
});
