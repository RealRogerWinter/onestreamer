// Unit tests for RotationRetryState (PR 17.1).
// Targets: exponential-backoff math, success/failure bookkeeping, the
// max-retries-reached path that waits maxDelayMs then resets, and the
// isLocked() bailout inside the scheduled retry callback.

const RotationRetryState = require('../../../services/random-stream/RotationRetryState');

describe('RotationRetryState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('construction', () => {
    test('defaults match the previous in-class retryConfig', () => {
      const r = new RotationRetryState();
      expect(r.config).toEqual({
        maxRetries: 5,
        baseDelayMs: 1500,
        maxDelayMs: 60000,
        backoffMultiplier: 2,
      });
      expect(r.state).toEqual({
        consecutiveFailures: 0,
        lastFailureTime: null,
        lastSuccessTime: null,
        currentRetryTimer: null,
      });
    });

    test('accepts overrides', () => {
      const r = new RotationRetryState({ maxRetries: 2, baseDelayMs: 100, maxDelayMs: 800, backoffMultiplier: 3 });
      expect(r.config.maxRetries).toBe(2);
      expect(r.config.baseDelayMs).toBe(100);
      expect(r.config.maxDelayMs).toBe(800);
      expect(r.config.backoffMultiplier).toBe(3);
    });
  });

  describe('calculateRetryDelay()', () => {
    test('grows exponentially with failure count', () => {
      const r = new RotationRetryState({ maxRetries: 10, baseDelayMs: 100, maxDelayMs: 100000, backoffMultiplier: 2 });
      expect(r.calculateRetryDelay()).toBe(100);
      r.state.consecutiveFailures = 1;
      expect(r.calculateRetryDelay()).toBe(200);
      r.state.consecutiveFailures = 2;
      expect(r.calculateRetryDelay()).toBe(400);
      r.state.consecutiveFailures = 3;
      expect(r.calculateRetryDelay()).toBe(800);
    });

    test('is capped at maxDelayMs', () => {
      const r = new RotationRetryState({ maxRetries: 20, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 });
      r.state.consecutiveFailures = 15;
      expect(r.calculateRetryDelay()).toBe(1000);
    });
  });

  describe('recordSuccess() / recordFailure() / shouldRetry()', () => {
    test('recordSuccess zeroes failures and stamps lastSuccessTime', () => {
      const r = new RotationRetryState();
      r.state.consecutiveFailures = 4;
      r.state.lastFailureTime = 1000;
      r.recordSuccess();
      expect(r.state.consecutiveFailures).toBe(0);
      expect(r.state.lastFailureTime).toBeNull();
      expect(typeof r.state.lastSuccessTime).toBe('number');
    });

    test('recordSuccess clears in-flight retry timer', () => {
      const r = new RotationRetryState();
      r.state.currentRetryTimer = setTimeout(() => {}, 9999);
      r.recordSuccess();
      expect(r.state.currentRetryTimer).toBeNull();
    });

    test('recordFailure increments and stamps lastFailureTime', () => {
      const r = new RotationRetryState();
      r.recordFailure();
      expect(r.state.consecutiveFailures).toBe(1);
      expect(typeof r.state.lastFailureTime).toBe('number');
      r.recordFailure();
      expect(r.state.consecutiveFailures).toBe(2);
    });

    test('shouldRetry returns true under maxRetries, false at/above', () => {
      const r = new RotationRetryState({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 });
      expect(r.shouldRetry()).toBe(true);
      r.state.consecutiveFailures = 2;
      expect(r.shouldRetry()).toBe(true);
      r.state.consecutiveFailures = 3;
      expect(r.shouldRetry()).toBe(false);
      r.state.consecutiveFailures = 99;
      expect(r.shouldRetry()).toBe(false);
    });
  });

  describe('clearTimer() / reset()', () => {
    test('clearTimer cancels a pending retry timer', () => {
      const r = new RotationRetryState();
      r.state.currentRetryTimer = setTimeout(() => {}, 9999);
      r.clearTimer();
      expect(r.state.currentRetryTimer).toBeNull();
    });

    test('reset clears failures + lastFailureTime but leaves the timer alone', () => {
      const r = new RotationRetryState();
      r.state.consecutiveFailures = 7;
      r.state.lastFailureTime = 999;
      const t = setTimeout(() => {}, 9999);
      r.state.currentRetryTimer = t;
      r.reset();
      expect(r.state.consecutiveFailures).toBe(0);
      expect(r.state.lastFailureTime).toBeNull();
      expect(r.state.currentRetryTimer).toBe(t);
      clearTimeout(t);
    });
  });

  describe('scheduleRetryWithBackoff()', () => {
    test('schedules op() after backoff delay and resolves with its result', async () => {
      const r = new RotationRetryState({ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 8000, backoffMultiplier: 2 });
      const op = jest.fn().mockResolvedValue({ success: true, attempt: 'first' });

      const p = r.scheduleRetryWithBackoff(op, 'unit-test');
      expect(op).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);
      const result = await p;

      expect(op).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true, attempt: 'first' });
    });

    test('uses growing delays as failures accumulate', async () => {
      const r = new RotationRetryState({ maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 60000, backoffMultiplier: 2 });
      r.state.consecutiveFailures = 2; // → delay should be 1000 * 2^2 = 4000ms
      const op = jest.fn().mockResolvedValue({ success: true });

      const p = r.scheduleRetryWithBackoff(op, 'growing');
      await jest.advanceTimersByTimeAsync(3999);
      expect(op).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await p;
      expect(op).toHaveBeenCalled();
    });

    test('bails out without invoking op when isLocked() returns true', async () => {
      const r = new RotationRetryState({ maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5000, backoffMultiplier: 2 });
      const op = jest.fn().mockResolvedValue({ success: true });

      const p = r.scheduleRetryWithBackoff(op, 'locked', { isLocked: () => true });
      await jest.advanceTimersByTimeAsync(500);
      const result = await p;

      expect(op).not.toHaveBeenCalled();
      expect(result).toEqual({ success: false, error: 'Rotation is locked' });
    });

    test('when shouldRetry()===false, waits maxDelayMs once then resets failure count and runs op', async () => {
      const r = new RotationRetryState({ maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 7000, backoffMultiplier: 2 });
      r.state.consecutiveFailures = 3; // at the cap
      expect(r.shouldRetry()).toBe(false);

      const op = jest.fn().mockResolvedValue({ success: true, recovered: true });
      const p = r.scheduleRetryWithBackoff(op, 'maxed-out');

      // Should wait the full maxDelayMs (7000), not the per-failure delay.
      await jest.advanceTimersByTimeAsync(6999);
      expect(op).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      const result = await p;

      expect(op).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(r.state.consecutiveFailures).toBe(0); // reset before op ran
    });

    test('logger.debug is called when supplied; absence is safe', async () => {
      const r = new RotationRetryState({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 2 });
      const debug = jest.fn();
      const op = jest.fn().mockResolvedValue({ success: true });

      const p = r.scheduleRetryWithBackoff(op, 'log-test', { logger: { debug } });
      await jest.advanceTimersByTimeAsync(100);
      await p;

      expect(debug).toHaveBeenCalled();
      // No logger argument → must not throw
      const p2 = r.scheduleRetryWithBackoff(op, 'no-logger');
      await jest.advanceTimersByTimeAsync(100);
      await p2;
    });
  });
});
