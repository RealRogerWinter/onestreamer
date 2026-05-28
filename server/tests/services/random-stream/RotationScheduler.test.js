/**
 * Unit tests for RotationScheduler (PR 17.3).
 *
 * The scheduler is glued to its host (RandomStreamRotationService) via a
 * `host` reference — these tests inject a hand-rolled stub host so the
 * scheduler can be exercised in isolation, without dragging the full
 * service module's `_loadState` / `TwitchRandomService` / `KickRandomService`
 * construction into the test setup.
 *
 * Coverage targets:
 *   - scheduleNext(): interval setting, getRandomInterval default, overwrite-
 *     existing-timer, callback fires after interval, callback respects
 *     isEnabled/isLocked/isRestarting, schedules countdowns
 *   - emitRotationTiming / emitFullRotationStatus shape + no-op gates
 *   - clearCountdownAnnouncements (idempotent)
 *   - scheduleCountdownAnnouncements bounds (0/1/2/3 announcements at the
 *     <30s / 45s / 90s / 4min remaining thresholds)
 *   - executeRotationWithRetry (success path / failure path / locked / disabled)
 */

const RotationScheduler = require('../../../services/random-stream/RotationScheduler');

function makeHost(overrides = {}) {
  const host = {
    isEnabled: true,
    isLocked: false,
    isRestarting: false,
    io: { emit: jest.fn() },
    currentStream: { urlId: 'abc', displayName: 'Lucky Wolf', platform: 'twitch' },
    retryState: { consecutiveFailures: 0, currentRetryTimer: null },
    sendChatAnnouncement: jest.fn(),
    getRandomInterval: jest.fn(() => 5 * 60 * 1000),
    _rotateToNewStream: jest.fn().mockResolvedValue({ success: true }),
    _recordSuccess: jest.fn(),
    _recordFailure: jest.fn(),
    _scheduleRetryWithBackoff: jest.fn().mockResolvedValue({ success: true }),
    _scheduleNextRotation: jest.fn(),
    _executeRotationWithRetry: jest.fn(),
    _emitRotationTiming: jest.fn(),
    _emitFullRotationStatus: jest.fn(),
    _scheduleCountdownAnnouncements: jest.fn(),
    ...overrides,
  };
  return host;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('scheduleNext()', () => {
  test('sets nextRotationAt + currentRotationDuration from supplied interval', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.scheduleNext(8 * 60 * 1000);
    expect(s.currentRotationDuration).toBe(8 * 60 * 1000);
    expect(s.nextRotationAt).toBe(Date.now() + 8 * 60 * 1000);
  });

  test('falls back to host.getRandomInterval() when no interval supplied', () => {
    const host = makeHost({ getRandomInterval: () => 7 * 60 * 1000 });
    const s = new RotationScheduler({ host });
    s.scheduleNext();
    expect(s.currentRotationDuration).toBe(7 * 60 * 1000);
  });

  test('clears any existing rotation timer before scheduling the new one', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.scheduleNext(60_000);
    const first = s.rotationTimer;
    s.scheduleNext(120_000);
    expect(s.rotationTimer).not.toBe(first);
    expect(s.rotationTimer).not.toBeNull();
  });

  test('routes scheduling side-effects through host (so external stubs intercept)', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.scheduleNext(30_000);
    expect(host._emitRotationTiming).toHaveBeenCalledTimes(1);
    expect(host._scheduleCountdownAnnouncements).toHaveBeenCalledTimes(1);
  });

  test('timer callback fires host._executeRotationWithRetry after the interval', async () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.scheduleNext(30_000);
    expect(host._executeRotationWithRetry).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(30_001);
    expect(host._executeRotationWithRetry).toHaveBeenCalledTimes(1);
  });

  test('timer callback does NOT fire when host.isEnabled becomes false', async () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.scheduleNext(30_000);
    host.isEnabled = false;
    await jest.advanceTimersByTimeAsync(30_001);
    expect(host._executeRotationWithRetry).not.toHaveBeenCalled();
  });

  test('timer callback does NOT fire when host.isLocked becomes true', async () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.scheduleNext(30_000);
    host.isLocked = true;
    await jest.advanceTimersByTimeAsync(30_001);
    expect(host._executeRotationWithRetry).not.toHaveBeenCalled();
  });

  test('timer callback re-schedules via host._scheduleNextRotation when host.isRestarting is true', async () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.scheduleNext(30_000);
    host.isRestarting = true;
    await jest.advanceTimersByTimeAsync(30_001);
    expect(host._scheduleNextRotation).toHaveBeenCalledTimes(1);
    expect(host._executeRotationWithRetry).not.toHaveBeenCalled();
  });
});

describe('emitRotationTiming()', () => {
  test('emits with nextRotationAt + currentRotationDuration + serverTime', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = 12345;
    s.currentRotationDuration = 67890;
    s.emitRotationTiming();
    expect(host.io.emit).toHaveBeenCalledWith('rotation-timing', {
      nextRotationAt: 12345,
      currentRotationDuration: 67890,
      serverTime: expect.any(Number),
    });
  });

  test('no-op when host.isEnabled is false', () => {
    const host = makeHost({ isEnabled: false });
    const s = new RotationScheduler({ host });
    s.emitRotationTiming();
    expect(host.io.emit).not.toHaveBeenCalled();
  });

  test('no-op when host.io is null', () => {
    const host = makeHost({ io: null });
    const s = new RotationScheduler({ host });
    expect(() => s.emitRotationTiming()).not.toThrow();
  });
});

describe('emitFullRotationStatus()', () => {
  test('emits random-rotation-status with rotationTiming nested block', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = 42;
    s.currentRotationDuration = 1000;
    s.emitFullRotationStatus();
    const call = host.io.emit.mock.calls.find(([evt]) => evt === 'random-rotation-status');
    expect(call[1]).toMatchObject({
      enabled: true,
      currentStream: host.currentStream,
      rotationTiming: { nextRotationAt: 42, currentRotationDuration: 1000, serverTime: expect.any(Number) },
    });
  });

  test('no-op when currentStream is null', () => {
    const host = makeHost({ currentStream: null });
    const s = new RotationScheduler({ host });
    s.emitFullRotationStatus();
    expect(host.io.emit).not.toHaveBeenCalled();
  });
});

describe('clearCountdownAnnouncements()', () => {
  test('clears every registered timer and empties the array', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.countdownAnnouncementTimers = [setTimeout(() => {}, 99999), setTimeout(() => {}, 99999)];
    s.clearCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers).toEqual([]);
  });

  test('idempotent: safe to call twice', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.clearCountdownAnnouncements();
    s.clearCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers).toEqual([]);
  });
});

describe('scheduleCountdownAnnouncements()', () => {
  test('schedules zero when host.isEnabled is false', () => {
    const host = makeHost({ isEnabled: false });
    const s = new RotationScheduler({ host });
    s.nextRotationAt = Date.now() + 5 * 60 * 1000;
    s.scheduleCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers.length).toBe(0);
  });

  test('schedules zero when nextRotationAt is null', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = null;
    s.scheduleCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers.length).toBe(0);
  });

  test('schedules 0 announcements with <30s remaining', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = Date.now() + 20_000;
    s.scheduleCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers.length).toBe(0);
  });

  test('schedules 1 announcement at ~45s remaining (only 30s threshold reachable)', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = Date.now() + 45_000;
    s.scheduleCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers.length).toBe(1);
  });

  test('schedules 2 announcements at ~90s remaining', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = Date.now() + 90_000;
    s.scheduleCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers.length).toBe(2);
  });

  test('schedules all 3 announcements at 4min+ remaining', () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = Date.now() + 4 * 60 * 1000;
    s.scheduleCountdownAnnouncements();
    expect(s.countdownAnnouncementTimers.length).toBe(3);
  });

  test('callback skips host.sendChatAnnouncement when host.isLocked at fire time', async () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    s.nextRotationAt = Date.now() + 45_000;
    s.scheduleCountdownAnnouncements();
    host.isLocked = true;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(host.sendChatAnnouncement).not.toHaveBeenCalled();
  });
});

describe('executeRotationWithRetry()', () => {
  test('no-op when host.isEnabled is false', async () => {
    const host = makeHost({ isEnabled: false });
    const s = new RotationScheduler({ host });
    await s.executeRotationWithRetry();
    expect(host._rotateToNewStream).not.toHaveBeenCalled();
  });

  test('no-op when host.isLocked is true', async () => {
    const host = makeHost({ isLocked: true });
    const s = new RotationScheduler({ host });
    await s.executeRotationWithRetry();
    expect(host._rotateToNewStream).not.toHaveBeenCalled();
  });

  test('on success: records success + reschedules via host + emits full status via host', async () => {
    const host = makeHost();
    const s = new RotationScheduler({ host });
    await s.executeRotationWithRetry();
    expect(host._recordSuccess).toHaveBeenCalled();
    expect(host._scheduleNextRotation).toHaveBeenCalled();
    expect(host._emitFullRotationStatus).toHaveBeenCalled();
  });

  test('on failure: records failure + calls host._scheduleRetryWithBackoff', async () => {
    const host = makeHost({
      _rotateToNewStream: jest.fn().mockResolvedValue({ success: false, error: 'boom' }),
    });
    const s = new RotationScheduler({ host });
    await s.executeRotationWithRetry();
    expect(host._recordFailure).toHaveBeenCalled();
    expect(host._scheduleRetryWithBackoff).toHaveBeenCalled();
  });

  test('defensive reschedule when failure path leaves nothing armed', async () => {
    const host = makeHost({
      _rotateToNewStream: jest.fn().mockResolvedValue({ success: false }),
      _scheduleRetryWithBackoff: jest.fn().mockResolvedValue({ success: false }),
    });
    const s = new RotationScheduler({ host });
    await s.executeRotationWithRetry();
    expect(host._scheduleNextRotation).toHaveBeenCalled();
  });
});
