/**
 * RotationRetryState — exponential-backoff retry bookkeeping for
 * RandomStreamRotationService. Owns `config` (max retries, base/max delay,
 * backoff multiplier) and `state` (consecutive failures, last-failure/
 * last-success timestamps, in-flight retry timer). Methods:
 *
 *   calculateRetryDelay()          → next delay in ms (capped at maxDelayMs)
 *   recordSuccess()                → resets failures + clears timer
 *   recordFailure()                → bumps failures, stamps lastFailureTime
 *   shouldRetry()                  → failures < maxRetries
 *   clearTimer()                   → cancels pending retry AND resolves its
 *                                    awaited promise with
 *                                    { success:false, cancelled:true } (T4:
 *                                    previously the awaiter hung forever)
 *   reset()                        → zeroes failures + lastFailureTime
 *   scheduleRetryWithBackoff(op, name, { isLocked, logger })
 *                                  → schedules `op()` after backoff delay;
 *                                    bails (returns { success:false }) if
 *                                    `isLocked()` returns true at fire time;
 *                                    on max-retries-exceeded, waits `maxDelayMs`
 *                                    once, then resets failure count and runs
 *                                    `op()` (never gives up permanently).
 *
 * Construction:
 *   new RotationRetryState({ maxRetries, baseDelayMs, maxDelayMs, backoffMultiplier })
 *
 * Extracted from RandomStreamRotationService.js (PR 17.1). The main service
 * keeps `this.retryConfig` and `this.retryState` as references to the helper's
 * own objects so existing in-file read sites stay byte-equivalent.
 */

class RotationRetryState {
  constructor({ maxRetries = 5, baseDelayMs = 1500, maxDelayMs = 60000, backoffMultiplier = 2 } = {}) {
    this.config = { maxRetries, baseDelayMs, maxDelayMs, backoffMultiplier };
    this.state = {
      consecutiveFailures: 0,
      lastFailureTime: null,
      lastSuccessTime: null,
      currentRetryTimer: null,
      // T4: resolver of the currently-awaited backoff promise, so cancel
      // sites can settle it instead of orphaning the awaiter.
      pendingResolve: null,
    };
  }

  calculateRetryDelay() {
    const { baseDelayMs, maxDelayMs, backoffMultiplier } = this.config;
    const failures = this.state.consecutiveFailures;
    return Math.min(baseDelayMs * Math.pow(backoffMultiplier, failures), maxDelayMs);
  }

  recordSuccess() {
    this.state.consecutiveFailures = 0;
    this.state.lastSuccessTime = Date.now();
    this.state.lastFailureTime = null;
    this.clearTimer();
  }

  recordFailure() {
    this.state.consecutiveFailures++;
    this.state.lastFailureTime = Date.now();
  }

  shouldRetry() {
    return this.state.consecutiveFailures < this.config.maxRetries;
  }

  clearTimer() {
    if (this.state.currentRetryTimer) {
      clearTimeout(this.state.currentRetryTimer);
      this.state.currentRetryTimer = null;
    }
    // T4: settle the awaited backoff promise so the awaiter's async frame
    // unwinds. `cancelled: true` tells it another actor took ownership of the
    // timer lifecycle (lock/pause/stop/forceRotate) — do not reschedule.
    if (this.state.pendingResolve) {
      const resolve = this.state.pendingResolve;
      this.state.pendingResolve = null;
      resolve({ success: false, cancelled: true });
    }
  }

  reset() {
    this.state.consecutiveFailures = 0;
    this.state.lastFailureTime = null;
  }

  async scheduleRetryWithBackoff(operation, operationName, { isLocked = () => false, logger } = {}) {
    const log = logger && typeof logger.debug === 'function' ? logger : null;

    if (!this.shouldRetry()) {
      const waitTime = Math.round(this.config.maxDelayMs / 1000);
      log?.debug(`⚠️ ROTATION: Max retries (${this.config.maxRetries}) reached for ${operationName}. Waiting ${waitTime}s before reset...`);

      return new Promise((resolve) => {
        this.state.currentRetryTimer = setTimeout(async () => {
          // T4 load-bearing: detach the resolver BEFORE running the op — the
          // op's own success path calls recordSuccess() → clearTimer(), and
          // without this the cancel resolution would win over the real result.
          this.state.pendingResolve = null;
          if (isLocked()) {
            log?.debug('🔒 ROTATION: Skipping retry - timer is locked');
            resolve({ success: false, error: 'Rotation is locked' });
            return;
          }
          log?.debug(`🔄 ROTATION: Resetting retry counter and attempting ${operationName} again...`);
          this.state.consecutiveFailures = 0;
          try {
            const result = await operation();
            resolve(result);
          } catch (err) {
            resolve({ success: false, error: err.message });
          }
        }, this.config.maxDelayMs);
        this.state.pendingResolve = resolve;
      });
    }

    const delay = this.calculateRetryDelay();
    const delaySeconds = Math.round(delay / 1000);
    log?.debug(`🔄 ROTATION: Retry ${this.state.consecutiveFailures}/${this.config.maxRetries} for ${operationName} in ${delaySeconds}s...`);

    return new Promise((resolve) => {
      this.state.currentRetryTimer = setTimeout(async () => {
        // T4: detach the resolver before the op runs (see max-retries branch).
        this.state.pendingResolve = null;
        if (isLocked()) {
          log?.debug('🔒 ROTATION: Skipping retry - timer is locked');
          resolve({ success: false, error: 'Rotation is locked' });
          return;
        }
        try {
          const result = await operation();
          resolve(result);
        } catch (err) {
          resolve({ success: false, error: err.message });
        }
      }, delay);
      this.state.pendingResolve = resolve;
    });
  }
}

module.exports = RotationRetryState;
