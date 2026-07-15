/**
 * T3 (stale-sweep half, audit Plan 05) — cleanupStaleSessions liveness.
 *
 * Raw 1-hour age alone force-ended LEGIT >60-minute streamers mid-stream
 * (they stopped accruing time/points). Past the age cut, the sweep now also
 * requires the session's socket to be gone from the 'streamer' room; without
 * io (unit topology) the old age-only behavior is preserved. The takeover
 * path ends ousted sessions directly (economy half), so the sweep is the
 * safety net for crashed sockets, not the exploit cap.
 */

jest.mock('../../services/AccountService', () => class AccountService {
  async updateUserStats() {}
});

const TimeTrackingService = require('../../services/TimeTrackingService');

function makeIoWithStreamerRoom(socketIds) {
  return {
    sockets: {
      adapter: { rooms: new Map([['streamer', new Set(socketIds)]]) },
      sockets: new Map(),
    },
    emit: jest.fn(),
  };
}

// endStreamingSession deletes the session AFTER an awaited stats write, so
// assertions that expect deletion must flush microtasks first.
const flush = () => new Promise((r) => setImmediate(r));

function seedStreamingSession(svc, userId, socketId, ageMs) {
  svc.activeSessions.set(userId, {
    startTime: Date.now() - ageMs,
    type: 'streaming',
    socketId,
  });
}

const TWO_HOURS = 2 * 60 * 60 * 1000;
const TEN_MIN = 10 * 60 * 1000;

describe('TimeTrackingService.cleanupStaleSessions (T3 stale-sweep half)', () => {
  test('a >1h session whose socket is still live in the streamer room is KEPT', () => {
    const svc = new TimeTrackingService(makeIoWithStreamerRoom(['sock-live']));
    seedStreamingSession(svc, 42, 'sock-live', TWO_HOURS);

    svc.cleanupStaleSessions();

    expect(svc.activeSessions.has(42)).toBe(true);
  });

  test('a >1h session whose socket left the streamer room is ended', async () => {
    const svc = new TimeTrackingService(makeIoWithStreamerRoom(['someone-else']));
    seedStreamingSession(svc, 42, 'sock-gone', TWO_HOURS);

    svc.cleanupStaleSessions();
    await flush();

    expect(svc.activeSessions.has(42)).toBe(false);
  });

  test('without io, the old age-only behavior is preserved (ended)', async () => {
    const svc = new TimeTrackingService(null);
    seedStreamingSession(svc, 42, 'sock-x', TWO_HOURS);

    svc.cleanupStaleSessions();
    await flush();

    expect(svc.activeSessions.has(42)).toBe(false);
  });

  test('a young session is untouched regardless of liveness', () => {
    const svc = new TimeTrackingService(makeIoWithStreamerRoom([]));
    seedStreamingSession(svc, 42, 'sock-y', TEN_MIN);

    svc.cleanupStaleSessions();

    expect(svc.activeSessions.has(42)).toBe(true);
  });
});
