/**
 * Scheduling-math tests for RandomStreamRotationService (PR 17.2).
 *
 * Pins the timer-management behaviour of the scheduling internals
 * (`_scheduleNextRotation`, `_scheduleCountdownAnnouncements`,
 * `_clearCountdownAnnouncements`, `_emitRotationTiming`,
 * `_emitFullRotationStatus`) before PR 17.3 lifts them into
 * `RotationScheduler`. Uses jest fake timers throughout so the multi-minute
 * setTimeout intervals don't leak into the event loop.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../data/random-rotation-state.json');

let backup;
let RandomStreamRotationService;

beforeAll(() => {
  if (fs.existsSync(STATE_FILE)) {
    backup = fs.readFileSync(STATE_FILE, 'utf8');
  }
});

afterAll(() => {
  if (backup !== undefined) {
    fs.writeFileSync(STATE_FILE, backup);
  } else if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
});

beforeEach(() => {
  // NOTE: do NOT unlink the STATE_FILE — parallel-worker race with
  // `RandomStreamRotationService.test.js` (see comment in
  // `RandomStreamRotationService.manualControl.test.js`).
  jest.resetModules();
  jest.useFakeTimers();
  RandomStreamRotationService = require('../../services/RandomStreamRotationService');
});

afterEach(() => {
  jest.useRealTimers();
});

function makeEnabledService({ minMin = 5, maxMin = 5 } = {}) {
  const svc = new RandomStreamRotationService();
  svc.io = { emit: jest.fn() };
  svc.isEnabled = true;
  svc.settings.minRotationMinutes = minMin;
  svc.settings.maxRotationMinutes = maxMin;
  return svc;
}

describe('_scheduleNextRotation', () => {
  test('sets nextRotationAt + currentRotationDuration based on the supplied interval', () => {
    const svc = makeEnabledService();
    svc._scheduleNextRotation(8 * 60 * 1000);
    expect(svc.currentRotationDuration).toBe(8 * 60 * 1000);
    expect(svc.nextRotationAt).toBe(Date.now() + 8 * 60 * 1000);
  });

  test('uses getRandomInterval() when no customInterval is supplied (min=max=5min → exactly 5min)', () => {
    const svc = makeEnabledService({ minMin: 5, maxMin: 5 });
    svc._scheduleNextRotation();
    expect(svc.currentRotationDuration).toBe(5 * 60 * 1000);
  });

  test('overwrites any existing rotation timer instead of leaking it', () => {
    const svc = makeEnabledService();
    svc._scheduleNextRotation(60_000);
    const firstTimer = svc.rotationTimer;
    expect(firstTimer).not.toBeNull();
    svc._scheduleNextRotation(120_000);
    expect(svc.rotationTimer).not.toBe(firstTimer);
    expect(svc.rotationTimer).not.toBeNull();
  });

  test('the scheduled rotation timer fires after the interval elapses', async () => {
    const svc = makeEnabledService();
    svc._executeRotationWithRetry = jest.fn().mockResolvedValue(undefined);
    svc._scheduleNextRotation(30_000);
    expect(svc._executeRotationWithRetry).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(30_001);
    expect(svc._executeRotationWithRetry).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire _executeRotationWithRetry when isEnabled becomes false before the timer pops', async () => {
    const svc = makeEnabledService();
    svc._executeRotationWithRetry = jest.fn();
    svc._scheduleNextRotation(30_000);
    svc.isEnabled = false;
    await jest.advanceTimersByTimeAsync(30_001);
    expect(svc._executeRotationWithRetry).not.toHaveBeenCalled();
  });

  test('does NOT fire _executeRotationWithRetry when isLocked is true at fire time', async () => {
    const svc = makeEnabledService();
    svc._executeRotationWithRetry = jest.fn();
    svc._scheduleNextRotation(30_000);
    svc.isLocked = true;
    await jest.advanceTimersByTimeAsync(30_001);
    expect(svc._executeRotationWithRetry).not.toHaveBeenCalled();
  });

  test('schedules a countdown announcement set on every reschedule', () => {
    const svc = makeEnabledService();
    svc.sendChatAnnouncement = jest.fn(); // prevent real HTTPS call
    expect(svc.countdownAnnouncementTimers).toEqual([]);
    svc._scheduleNextRotation(5 * 60 * 1000); // 5min has 3-of-3 announcements (3min, 1min, 30s)
    expect(svc.countdownAnnouncementTimers.length).toBe(3);
  });

  test('emits rotation-timing when there is an io socket and isEnabled', () => {
    const svc = makeEnabledService();
    svc._scheduleNextRotation(60_000);
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-timing');
    expect(emit).toBeDefined();
    expect(emit[1]).toMatchObject({
      nextRotationAt: expect.any(Number),
      currentRotationDuration: 60_000,
      serverTime: expect.any(Number),
    });
  });
});

describe('_clearCountdownAnnouncements', () => {
  test('clears every registered timer and empties the array', () => {
    const svc = makeEnabledService();
    svc.countdownAnnouncementTimers = [setTimeout(() => {}, 99999), setTimeout(() => {}, 99999)];
    svc._clearCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers).toEqual([]);
  });

  test('idempotent: clears twice in a row safely', () => {
    const svc = makeEnabledService();
    svc._clearCountdownAnnouncements();
    svc._clearCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers).toEqual([]);
  });
});

describe('_scheduleCountdownAnnouncements', () => {
  test('schedules zero announcements when isEnabled is false', () => {
    const svc = makeEnabledService();
    svc.isEnabled = false;
    svc.nextRotationAt = Date.now() + 5 * 60 * 1000;
    svc._scheduleCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers.length).toBe(0);
  });

  test('schedules zero announcements when nextRotationAt is null', () => {
    const svc = makeEnabledService();
    svc.nextRotationAt = null;
    svc._scheduleCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers.length).toBe(0);
  });

  test('schedules 0 announcements when <30s remaining (all three thresholds passed)', () => {
    const svc = makeEnabledService();
    svc.nextRotationAt = Date.now() + 20_000; // 20s remaining
    svc._scheduleCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers.length).toBe(0);
  });

  test('schedules 1 announcement when only the 30s threshold is reachable', () => {
    const svc = makeEnabledService();
    svc.nextRotationAt = Date.now() + 45_000;
    svc._scheduleCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers.length).toBe(1);
  });

  test('schedules 2 announcements when 1min and 30s thresholds are reachable', () => {
    const svc = makeEnabledService();
    svc.nextRotationAt = Date.now() + 90_000; // 1.5min remaining
    svc._scheduleCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers.length).toBe(2);
  });

  test('schedules all 3 announcements when 3min+ remaining', () => {
    const svc = makeEnabledService();
    svc.nextRotationAt = Date.now() + 4 * 60 * 1000;
    svc._scheduleCountdownAnnouncements();
    expect(svc.countdownAnnouncementTimers.length).toBe(3);
  });

  test('callback does NOT send announcement when isLocked at fire time', async () => {
    const svc = makeEnabledService();
    svc.sendChatAnnouncement = jest.fn();
    svc.nextRotationAt = Date.now() + 45_000;
    svc._scheduleCountdownAnnouncements();
    svc.isLocked = true;
    await jest.advanceTimersByTimeAsync(20_000); // past the 30s-remaining trigger
    expect(svc.sendChatAnnouncement).not.toHaveBeenCalled();
  });

  test('callback does NOT send announcement when isEnabled flipped to false at fire time', async () => {
    const svc = makeEnabledService();
    svc.sendChatAnnouncement = jest.fn();
    svc.nextRotationAt = Date.now() + 45_000;
    svc._scheduleCountdownAnnouncements();
    svc.isEnabled = false;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(svc.sendChatAnnouncement).not.toHaveBeenCalled();
  });

  test('callback fires sendChatAnnouncement with one of the configured messages', async () => {
    const svc = makeEnabledService();
    svc.sendChatAnnouncement = jest.fn();
    svc.nextRotationAt = Date.now() + 45_000;
    svc._scheduleCountdownAnnouncements();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(svc.sendChatAnnouncement).toHaveBeenCalledTimes(1);
    const msg = svc.sendChatAnnouncement.mock.calls[0][0];
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });
});

describe('_emitRotationTiming', () => {
  test('emits when isEnabled and io are both set', () => {
    const svc = makeEnabledService();
    svc.nextRotationAt = 12345;
    svc.currentRotationDuration = 30000;
    svc._emitRotationTiming();
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-timing');
    expect(emit[1]).toMatchObject({
      nextRotationAt: 12345,
      currentRotationDuration: 30000,
      serverTime: expect.any(Number),
    });
  });

  test('is a no-op when isEnabled is false', () => {
    const svc = makeEnabledService();
    svc.isEnabled = false;
    svc._emitRotationTiming();
    expect(svc.io.emit).not.toHaveBeenCalled();
  });

  test('is a no-op when io is null', () => {
    const svc = makeEnabledService();
    svc.io = null;
    expect(() => svc._emitRotationTiming()).not.toThrow();
  });
});

describe('_emitFullRotationStatus', () => {
  test('emits random-rotation-status with timing data when running', () => {
    const svc = makeEnabledService();
    svc.currentStream = { urlId: 'x', displayName: 'Lucky Wolf', platform: 'twitch' };
    svc.nextRotationAt = 12345;
    svc.currentRotationDuration = 30000;
    svc._emitFullRotationStatus();
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'random-rotation-status');
    expect(emit[1]).toMatchObject({
      enabled: true,
      currentStream: expect.any(Object),
      rotationTiming: {
        nextRotationAt: 12345,
        currentRotationDuration: 30000,
        serverTime: expect.any(Number),
      },
    });
  });

  test('is a no-op when currentStream is null', () => {
    const svc = makeEnabledService();
    svc.currentStream = null;
    svc._emitFullRotationStatus();
    expect(svc.io.emit).not.toHaveBeenCalled();
  });
});

describe('_executeRotationWithRetry', () => {
  test('returns early when isEnabled is false', async () => {
    const svc = makeEnabledService();
    svc.isEnabled = false;
    svc._rotateToNewStream = jest.fn();
    await svc._executeRotationWithRetry();
    expect(svc._rotateToNewStream).not.toHaveBeenCalled();
  });

  test('returns early when isLocked is true', async () => {
    const svc = makeEnabledService();
    svc.isLocked = true;
    svc._rotateToNewStream = jest.fn();
    await svc._executeRotationWithRetry();
    expect(svc._rotateToNewStream).not.toHaveBeenCalled();
  });

  test('on success: records success + reschedules + emits full status', async () => {
    const svc = makeEnabledService();
    svc._rotateToNewStream = jest.fn().mockResolvedValue({ success: true });
    svc._scheduleNextRotation = jest.fn();
    svc._emitFullRotationStatus = jest.fn();
    svc.retryState.consecutiveFailures = 2;
    await svc._executeRotationWithRetry();
    expect(svc.retryState.consecutiveFailures).toBe(0);
    expect(svc._scheduleNextRotation).toHaveBeenCalled();
    expect(svc._emitFullRotationStatus).toHaveBeenCalled();
  });

  test('on failure: records failure + invokes the backoff retry path', async () => {
    const svc = makeEnabledService();
    svc._rotateToNewStream = jest.fn().mockResolvedValue({ success: false, error: 'boom' });
    svc._scheduleRetryWithBackoff = jest.fn().mockResolvedValue({ success: false });
    await svc._executeRotationWithRetry();
    expect(svc.retryState.consecutiveFailures).toBe(1);
    expect(svc._scheduleRetryWithBackoff).toHaveBeenCalled();
  });
});
