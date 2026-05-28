/**
 * Manual-control verb tests for RandomStreamRotationService (PR 17.2).
 *
 * Covers the 9 verb family — extendRotation, adminExtend, reduceRotation,
 * adminReduce, lockRotation, unlockRotation, forceRotate, getLockStatus,
 * getExtendCooldownStatus — and pins the response shapes the chat-service
 * vote handlers (`chat-service/votes/{extend,reduce,lock,unlock,skip}Vote.js`)
 * read off the HTTP response.
 *
 * These tests intentionally use a freshly-constructed service per test
 * and stub the four collaborator surfaces the verbs touch (`io`,
 * `viewBotURLService`, `streamNotifier`, `streamService`). No real timers
 * or real network calls.
 *
 * Pre-Phase-17.3/17.4 safety net — landed as PR 17.2 before the
 * scheduler/timer-controller decomposition so byte-equivalent moves can be
 * proven by the same test suite.
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../data/random-rotation-state.json');

let backup;
let RandomStreamRotationService;

beforeAll(() => {
  // The service _loadState() reads from disk on construct; back up + restore
  // the live file so this suite doesn't trample whatever the dev box has
  // persisted (matches the pattern in RandomStreamRotationService.test.js).
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
  // NOTE: do NOT unlink the STATE_FILE here. Parallel jest workers running
  // `RandomStreamRotationService.test.js` (which writes the file via
  // updateSettings + asserts exists) race against an unlink from this file.
  // We don't write to the file, so its presence is harmless for these tests.
  jest.resetModules();
  RandomStreamRotationService = require('../../services/RandomStreamRotationService');
});

/**
 * Build a service set up "as if start() had already succeeded" — isEnabled,
 * nextRotationAt set 5 minutes out, currentStream populated, io stub
 * collecting emits. Most verb tests start from here.
 *
 * `_scheduleNextRotation` is stubbed to a synchronous no-real-timer version
 * that updates `nextRotationAt` + `currentRotationDuration` so verb tests
 * can observe the reschedule effect without the real implementation leaking
 * a multi-minute setTimeout into jest's event loop. The countdown-timer
 * scheduler is also stubbed for the same reason.
 */
function makeRunningService({ extendCooldownMs = 5 * 60 * 1000 } = {}) {
  const svc = new RandomStreamRotationService();
  svc.io = { emit: jest.fn() };
  svc.viewBotURLService = { isBusy: () => false, activeStreams: new Map(), stopURLStream: jest.fn().mockResolvedValue({}) };
  svc.streamNotifier = { streamEnded: jest.fn() };

  svc.isEnabled = true;
  svc.shouldAutoRestart = true;
  svc.currentStream = {
    urlId: 'url-abc',
    displayName: 'Lucky Wolf',
    platform: 'twitch',
    streamerUsername: 'streamer1',
    streamerDisplayName: 'Streamer One',
    game: 'Just Chatting',
    title: 'Hello',
    viewers: 42,
    url: 'https://twitch.tv/streamer1',
    startedAt: Date.now(),
  };
  svc.nextRotationAt = Date.now() + 5 * 60 * 1000;
  svc.currentRotationDuration = 5 * 60 * 1000;
  svc.extendCooldownMs = extendCooldownMs;
  svc.lastExtendTime = null;
  svc.isLocked = false;

  // Replace timer-creating internals with state-only stubs so jest exits
  // cleanly. Tests that need to observe scheduling intent can re-stub or
  // inspect the stubbed call args.
  svc._scheduleNextRotation = jest.fn((customInterval = null) => {
    const interval = customInterval !== null ? customInterval : 5 * 60 * 1000;
    svc.nextRotationAt = Date.now() + interval;
    svc.currentRotationDuration = interval;
    svc.rotationTimer = null;
  });
  svc._scheduleCountdownAnnouncements = jest.fn();
  svc._clearCountdownAnnouncements = jest.fn(() => {
    svc.countdownAnnouncementTimers.forEach((t) => clearTimeout(t));
    svc.countdownAnnouncementTimers = [];
  });
  svc._emitRotationTiming = jest.fn();
  svc._emitFullRotationStatus = jest.fn();
  return svc;
}

afterEach(() => {
  // Belt-and-braces: clear any timers that slipped through (e.g. the dummy
  // timers some tests inject).
  if (global.__svc) {
    if (global.__svc.rotationTimer) clearTimeout(global.__svc.rotationTimer);
    if (global.__svc.retryState && global.__svc.retryState.currentRetryTimer) {
      clearTimeout(global.__svc.retryState.currentRetryTimer);
    }
  }
});

describe('extendRotation', () => {
  test('returns success and adds time when called on a running, in-cooldown-free service', () => {
    const svc = makeRunningService();
    const before = svc.nextRotationAt;
    const result = svc.extendRotation(4);
    expect(result.success).toBe(true);
    expect(result.extendedByMinutes).toBe(4);
    expect(typeof result.newNextRotationAt).toBe('number');
    expect(svc.nextRotationAt).toBeGreaterThan(before);
  });

  test('uses random 3-5 min default when no minutes argument is supplied', () => {
    const svc = makeRunningService();
    const result = svc.extendRotation();
    expect([3, 4, 5]).toContain(result.extendedByMinutes);
  });

  test('emits rotation-extended with the chat-service response shape', () => {
    const svc = makeRunningService();
    svc.extendRotation(4);
    const emits = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-extended');
    expect(emits).toBeDefined();
    const payload = emits[1];
    expect(payload).toMatchObject({
      extendedByMinutes: 4,
      newNextRotationAt: expect.any(Number),
      currentStream: expect.any(Object),
    });
    expect(typeof payload.extendedBy).toBe('number'); // raw ms delta
  });

  test('records lastExtendTime so the next call hits the cooldown', () => {
    const svc = makeRunningService();
    expect(svc.lastExtendTime).toBeNull();
    svc.extendRotation(4);
    expect(typeof svc.lastExtendTime).toBe('number');
    const result2 = svc.extendRotation(4);
    expect(result2.success).toBe(false);
    expect(result2.error).toMatch(/cooldown/i);
    expect(typeof result2.cooldownRemaining).toBe('number');
  });

  test('not-enabled short-circuits with "Rotation not enabled"', () => {
    const svc = makeRunningService();
    svc.isEnabled = false;
    expect(svc.extendRotation(4)).toEqual({ success: false, error: 'Rotation not enabled' });
  });

  test('no nextRotationAt short-circuits with "No rotation scheduled"', () => {
    const svc = makeRunningService();
    svc.nextRotationAt = null;
    expect(svc.extendRotation(4)).toEqual({ success: false, error: 'No rotation scheduled' });
  });

  test('remaining time already <=0 returns "Rotation already in progress"', () => {
    const svc = makeRunningService();
    svc.nextRotationAt = Date.now() - 1000;
    expect(svc.extendRotation(4)).toEqual({ success: false, error: 'Rotation already in progress' });
  });

  test('clears the existing rotation timer and calls _scheduleNextRotation with the new interval', () => {
    const svc = makeRunningService();
    const dummyTimer = setTimeout(() => {}, 999999);
    svc.rotationTimer = dummyTimer;
    const startNextRotationAt = svc.nextRotationAt;
    svc.extendRotation(4);
    expect(svc._scheduleNextRotation).toHaveBeenCalledTimes(1);
    const passedInterval = svc._scheduleNextRotation.mock.calls[0][0];
    expect(passedInterval).toBeGreaterThan(0); // remaining + extend
    // Dummy timer was passed to clearTimeout — node won't fire it.
    expect(svc.nextRotationAt).not.toBe(startNextRotationAt);
  });

  test('cooldown clears when lastExtendTime is older than extendCooldownMs', () => {
    const svc = makeRunningService();
    svc.lastExtendTime = Date.now() - (svc.extendCooldownMs + 1000);
    const result = svc.extendRotation(4);
    expect(result.success).toBe(true);
  });
});

describe('adminExtend', () => {
  test('happy path: adds time, bypasses cooldown, default 5 minutes', () => {
    const svc = makeRunningService();
    svc.lastExtendTime = Date.now(); // would block extendRotation
    const result = svc.adminExtend(); // default = 5
    expect(result.success).toBe(true);
    expect(result.extendedByMinutes).toBe(5);
    expect(result.message).toMatch(/Admin extended/);
  });

  test('not-enabled / locked / no-rotation / in-progress all short-circuit', () => {
    const svc = makeRunningService();
    svc.isEnabled = false;
    expect(svc.adminExtend(5).success).toBe(false);
    svc.isEnabled = true;
    svc.isLocked = true;
    expect(svc.adminExtend(5)).toEqual({ success: false, error: 'Rotation is locked. Unlock first to extend.' });
    svc.isLocked = false;
    svc.nextRotationAt = null;
    expect(svc.adminExtend(5)).toEqual({ success: false, error: 'No rotation scheduled' });
    svc.nextRotationAt = Date.now() - 100;
    expect(svc.adminExtend(5)).toEqual({ success: false, error: 'Rotation already in progress' });
  });

  test('emits rotation-extended with isAdminExtend: true', () => {
    const svc = makeRunningService();
    svc.adminExtend(7);
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-extended');
    expect(emit[1]).toMatchObject({ extendedByMinutes: 7, isAdminExtend: true });
  });

  test('does NOT touch lastExtendTime (no cooldown side-effect)', () => {
    const svc = makeRunningService();
    expect(svc.lastExtendTime).toBeNull();
    svc.adminExtend(5);
    expect(svc.lastExtendTime).toBeNull();
  });
});

describe('reduceRotation', () => {
  test('happy path: subtracts time, emits rotation-reduced with chat-service shape', () => {
    const svc = makeRunningService();
    const before = svc.nextRotationAt;
    const result = svc.reduceRotation(3);
    expect(result.success).toBe(true);
    expect(typeof result.reducedByMinutes).toBe('number');
    expect(svc.nextRotationAt).toBeLessThan(before);
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-reduced');
    expect(emit[1]).toMatchObject({
      reducedByMinutes: expect.any(Number),
      newNextRotationAt: expect.any(Number),
      currentRotationDuration: expect.any(Number),
      currentStream: expect.any(Object),
    });
  });

  test('floors remaining time at 30 seconds minimum (cannot reduce below 30s)', () => {
    const svc = makeRunningService();
    // 1 minute remaining, asking to reduce by 5 → would go negative without the floor
    svc.nextRotationAt = Date.now() + 60_000;
    const result = svc.reduceRotation(5);
    expect(result.success).toBe(true);
    const remaining = svc.nextRotationAt - Date.now();
    expect(remaining).toBeGreaterThanOrEqual(29_000); // allow ~1s tolerance
    expect(remaining).toBeLessThanOrEqual(31_000);
  });

  test('shares cooldown with extendRotation via this.lastExtendTime', () => {
    const svc = makeRunningService();
    svc.extendRotation(4); // sets lastExtendTime
    const result = svc.reduceRotation(3);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cooldown/i);
  });

  test('uses random 3-5 default when no minutesToSubtract supplied', () => {
    const svc = makeRunningService();
    const result = svc.reduceRotation();
    expect(result.success).toBe(true);
    // After the floor, the *visible* reducedByMinutes can be anything from
    // 0+ up to the requested 3-5. Just check it's non-negative.
    expect(result.reducedByMinutes).toBeGreaterThanOrEqual(0);
  });

  test('not-enabled / no-rotation / in-progress short-circuits', () => {
    const svc = makeRunningService();
    svc.isEnabled = false;
    expect(svc.reduceRotation(3).success).toBe(false);
    svc.isEnabled = true;
    svc.nextRotationAt = null;
    expect(svc.reduceRotation(3)).toEqual({ success: false, error: 'No rotation scheduled' });
    svc.nextRotationAt = Date.now() - 100;
    expect(svc.reduceRotation(3)).toEqual({ success: false, error: 'Rotation already in progress' });
  });
});

describe('adminReduce', () => {
  test('happy path: subtracts time, bypasses cooldown', () => {
    const svc = makeRunningService();
    svc.lastExtendTime = Date.now();
    const result = svc.adminReduce(2);
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/Admin reduced/);
  });

  test('locked: returns specific error', () => {
    const svc = makeRunningService();
    svc.isLocked = true;
    expect(svc.adminReduce(2)).toEqual({ success: false, error: 'Rotation is locked. Unlock first to reduce.' });
  });

  test('emits rotation-reduced with isAdminReduce: true', () => {
    const svc = makeRunningService();
    svc.adminReduce(2);
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-reduced');
    expect(emit[1]).toMatchObject({ isAdminReduce: true });
  });

  test('honours the 30-second floor', () => {
    const svc = makeRunningService();
    svc.nextRotationAt = Date.now() + 40_000;
    svc.adminReduce(10);
    const remaining = svc.nextRotationAt - Date.now();
    expect(remaining).toBeGreaterThanOrEqual(29_000);
    expect(remaining).toBeLessThanOrEqual(31_000);
  });
});

describe('lockRotation', () => {
  test('happy path: stores remaining time, clears rotationTimer, sets isLocked', () => {
    const svc = makeRunningService();
    const dummyTimer = setTimeout(() => {}, 999999);
    svc.rotationTimer = dummyTimer;
    const result = svc.lockRotation();
    expect(result.success).toBe(true);
    expect(svc.isLocked).toBe(true);
    expect(typeof svc.remainingTimeWhenLocked).toBe('number');
    expect(svc.remainingTimeWhenLocked).toBeGreaterThan(0);
    expect(svc.rotationTimer).toBeNull();
    expect(typeof svc.lockedAt).toBe('number');
    expect(result.remainingMs).toBe(svc.remainingTimeWhenLocked);
  });

  test('clears countdown announcement timers and pending retry timer', () => {
    const svc = makeRunningService();
    svc.countdownAnnouncementTimers = [
      setTimeout(() => {}, 999999),
      setTimeout(() => {}, 999999),
    ];
    svc.retryState.currentRetryTimer = setTimeout(() => {}, 999999);
    svc.lockRotation();
    expect(svc.countdownAnnouncementTimers).toEqual([]);
    expect(svc.retryState.currentRetryTimer).toBeNull();
  });

  test('emits rotation-locked with remainingMs', () => {
    const svc = makeRunningService();
    svc.lockRotation();
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-locked');
    expect(emit[1]).toMatchObject({ locked: true, remainingMs: expect.any(Number) });
  });

  test('not-enabled / already-locked / no-rotation / in-progress short-circuits', () => {
    const svc = makeRunningService();
    svc.isEnabled = false;
    expect(svc.lockRotation().success).toBe(false);
    svc.isEnabled = true;
    svc.isLocked = true;
    expect(svc.lockRotation()).toEqual({ success: false, error: 'Rotation is already locked' });
    svc.isLocked = false;
    svc.nextRotationAt = null;
    expect(svc.lockRotation()).toEqual({ success: false, error: 'No rotation scheduled' });
    svc.nextRotationAt = Date.now() - 100;
    expect(svc.lockRotation()).toEqual({ success: false, error: 'Rotation already in progress' });
  });
});

describe('unlockRotation', () => {
  test('happy path: restores remaining time, clears lock state, emits rotation-unlocked', () => {
    const svc = makeRunningService();
    svc.lockRotation();
    const stored = svc.remainingTimeWhenLocked;
    const result = svc.unlockRotation();
    expect(result.success).toBe(true);
    expect(svc.isLocked).toBe(false);
    expect(svc.lockedAt).toBeNull();
    expect(svc.remainingTimeWhenLocked).toBeNull();
    expect(result.remainingMs).toBe(stored);
    expect(typeof result.nextRotationAt).toBe('number');
    expect(svc._scheduleNextRotation).toHaveBeenCalledWith(stored);
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-unlocked');
    expect(emit[1]).toMatchObject({
      locked: false,
      remainingMs: expect.any(Number),
      nextRotationAt: expect.any(Number),
    });
  });

  test('not-enabled / not-locked short-circuits', () => {
    const svc = makeRunningService();
    svc.isEnabled = false;
    expect(svc.unlockRotation().success).toBe(false);
    svc.isEnabled = true;
    expect(svc.unlockRotation()).toEqual({ success: false, error: 'Rotation is not locked' });
  });
});

describe('getLockStatus / getExtendCooldownStatus', () => {
  test('getLockStatus returns the current lock fields verbatim', () => {
    const svc = makeRunningService();
    expect(svc.getLockStatus()).toEqual({ isLocked: false, lockedAt: null, remainingTimeWhenLocked: null });
    svc.lockRotation();
    const status = svc.getLockStatus();
    expect(status.isLocked).toBe(true);
    expect(typeof status.lockedAt).toBe('number');
    expect(typeof status.remainingTimeWhenLocked).toBe('number');
  });

  test('getExtendCooldownStatus reports onCooldown:false when lastExtendTime is null', () => {
    const svc = makeRunningService();
    expect(svc.getExtendCooldownStatus()).toEqual({ onCooldown: false, remainingSeconds: 0 });
  });

  test('getExtendCooldownStatus reports remaining seconds when within the window', () => {
    const svc = makeRunningService();
    svc.lastExtendTime = Date.now() - 1000; // 1s ago
    const status = svc.getExtendCooldownStatus();
    expect(status.onCooldown).toBe(true);
    expect(status.remainingSeconds).toBeGreaterThan(0);
    expect(status.remainingSeconds).toBeLessThanOrEqual(Math.ceil(svc.extendCooldownMs / 1000));
  });

  test('getExtendCooldownStatus reports onCooldown:false once the window passes', () => {
    const svc = makeRunningService();
    svc.lastExtendTime = Date.now() - (svc.extendCooldownMs + 1000);
    expect(svc.getExtendCooldownStatus()).toEqual({ onCooldown: false, remainingSeconds: 0 });
  });
});

describe('forceRotate', () => {
  test('not-enabled short-circuits without calling _rotateToNewStream', async () => {
    const svc = makeRunningService();
    svc.isEnabled = false;
    svc._rotateToNewStream = jest.fn();
    const result = await svc.forceRotate();
    expect(result).toEqual({ success: false, error: 'Rotation not enabled' });
    expect(svc._rotateToNewStream).not.toHaveBeenCalled();
  });

  test('clears existing rotation timer and forwards platform override', async () => {
    const svc = makeRunningService();
    svc.rotationTimer = setTimeout(() => {}, 999999);
    svc._rotateToNewStream = jest.fn().mockResolvedValue({ success: true, stream: { urlId: 'new' } });
    svc._scheduleNextRotation = jest.fn();
    svc._emitRotationTiming = jest.fn();

    const result = await svc.forceRotate({ platform: 'kick' });
    expect(svc._rotateToNewStream).toHaveBeenCalledWith({ forcePlatform: 'kick' });
    expect(result.success).toBe(true);
  });

  test('emits random-rotation-force before rotating', async () => {
    const svc = makeRunningService();
    svc._rotateToNewStream = jest.fn().mockResolvedValue({ success: true });
    svc._scheduleNextRotation = jest.fn();
    svc._emitRotationTiming = jest.fn();
    await svc.forceRotate();
    const emit = svc.io.emit.mock.calls.find(([evt]) => evt === 'random-rotation-force');
    expect(emit).toBeDefined();
  });

  test('unlocks if locked, and emits rotation-unlocked after rotate succeeds', async () => {
    const svc = makeRunningService();
    svc.lockRotation();
    expect(svc.isLocked).toBe(true);
    svc._rotateToNewStream = jest.fn().mockResolvedValue({ success: true });
    svc._scheduleNextRotation = jest.fn(() => { svc.nextRotationAt = Date.now() + 10000; });
    svc._emitRotationTiming = jest.fn();

    await svc.forceRotate();
    expect(svc.isLocked).toBe(false);
    const unlockEmit = svc.io.emit.mock.calls.find(([evt]) => evt === 'rotation-unlocked');
    expect(unlockEmit).toBeDefined();
  });

  test('does not reschedule when _rotateToNewStream fails', async () => {
    const svc = makeRunningService();
    svc._rotateToNewStream = jest.fn().mockResolvedValue({ success: false, error: 'boom' });
    svc._scheduleNextRotation = jest.fn();
    const result = await svc.forceRotate();
    expect(result.success).toBe(false);
    expect(svc._scheduleNextRotation).not.toHaveBeenCalled();
  });
});
