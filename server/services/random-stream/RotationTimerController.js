/**
 * RotationTimerController — the 9 manual-control verbs that mutate the
 * rotation timer state. Extracted from RandomStreamRotationService in PR 17.4.
 *
 * Verbs (all preserve byte-equivalent response shapes — the chat-service
 * vote handlers under `chat-service/votes/{extend,reduce,lock,unlock,skip}Vote.js`
 * read `response.data.success`, `response.data.error`,
 * `response.data.extendedByMinutes`, and `response.data.reducedByMinutes`
 * directly):
 *
 *   extend(mins?)                  — chat-vote, 5-min cooldown, random 3-5 default
 *   adminExtend(mins?)             — bypasses cooldown, default 5
 *   reduce(mins?)                  — chat-vote, shares cooldown w/ extend
 *   adminReduce(mins?)             — bypasses cooldown, default 5
 *   lock()                         — freezes timer; stores remaining time
 *   unlock()                       — resumes timer with stored remaining
 *   forceRotate(options?)          — overrides lock + immediate rotate
 *   getLockStatus()                — { isLocked, lockedAt, remainingTimeWhenLocked }
 *   getExtendCooldownStatus()      — { onCooldown, remainingSeconds }
 *
 * State owned by this helper (previously on the main service):
 *   lastExtendTime, extendCooldownMs, extendMinutes,
 *   isLocked, lockedAt, remainingTimeWhenLocked
 *
 * The main service re-exposes each via property accessors so consumer
 * call-sites (`_setupStreamEndedListener`'s logger probes, `getStatus`,
 * the auto-restart monitor, the retry-helper's `isLocked` callback)
 * keep working byte-equivalent.
 *
 * Cross-helper collaboration (via this.host.*):
 *   host.isEnabled, host.io, host.currentStream
 *   host._rotateToNewStream() (for forceRotate)
 *   host._scheduleNextRotation() (for extend/reduce/unlock reschedules)
 *   host._emitRotationTiming() (for forceRotate post-emit)
 *   host._clearCountdownAnnouncements() (lock clears countdowns)
 *   host._clearRetryTimer() / host._recordSuccess() (lock/forceRotate cancel
 *     or reset the pending retry via the RotationRetryState helper — T4)
 *   host.rotationTimer (cleared before reschedule)
 *   host.nextRotationAt (read for remaining-time math)
 */

const RANDOM_EXTEND_RANGE = 3; // base 3 + Math.floor(rand*3) = 3..5 inclusive
const MIN_REMAINING_MS_FLOOR = 30 * 1000; // reduce/admin-reduce can't go below 30s

class RotationTimerController {
  constructor({ host, logger }) {
    this.host = host;
    this.logger = logger;

    // Extend-cooldown state
    this.lastExtendTime = null;
    this.extendCooldownMs = 5 * 60 * 1000;
    this.extendMinutes = 4;

    // Lock state
    this.isLocked = false;
    this.lockedAt = null;
    this.remainingTimeWhenLocked = null;
  }

  // ---- Shared preconditions ------------------------------------------------
  _requireEnabled() {
    if (!this.host.isEnabled) return { success: false, error: 'Rotation not enabled' };
    return null;
  }

  _requireScheduled() {
    if (!this.host.nextRotationAt) return { success: false, error: 'No rotation scheduled' };
    return null;
  }

  _remainingMs() {
    return this.host.nextRotationAt - Date.now();
  }

  _checkCooldown(label) {
    if (!this.lastExtendTime) return null;
    const timeSinceLastExtend = Date.now() - this.lastExtendTime;
    if (timeSinceLastExtend < this.extendCooldownMs) {
      const remainingCooldown = Math.ceil((this.extendCooldownMs - timeSinceLastExtend) / 1000);
      return {
        success: false,
        error: `${label} on cooldown. ${remainingCooldown} seconds remaining.`,
        cooldownRemaining: remainingCooldown,
      };
    }
    return null;
  }

  _clearActiveRotationTimer() {
    if (this.host.rotationTimer) {
      clearTimeout(this.host.rotationTimer);
      this.host.rotationTimer = null;
    }
  }

  // ---- forceRotate ---------------------------------------------------------
  async forceRotate(options = {}) {
    const { platform = null } = options;
    const host = this.host;

    const notEnabled = this._requireEnabled();
    if (notEnabled) return notEnabled;

    // T2: deny force-rotate while a takeover critical section runs (same
    // response shape the chat-service vote handlers read).
    if (global.streamService?.takeoverInProgress) {
      return { success: false, error: 'Takeover in progress' };
    }

    this.logger?.debug?.(`🔄 Force rotating to new stream...${platform ? ` (platform: ${platform})` : ''}`);

    // If locked, unlock first (force rotate overrides lock).
    const wasLocked = this.isLocked;
    if (this.isLocked) {
      this.logger?.debug?.('🔓 ROTATION: Force rotate - unlocking timer');
      this.isLocked = false;
      this.lockedAt = null;
      this.remainingTimeWhenLocked = null;
    }

    if (host.io) {
      host.io.emit('random-rotation-force', {
        previousStream: host.currentStream ? {
          displayName: host.currentStream.displayName,
          platform: host.currentStream.platform,
        } : null,
      });
    }

    this._clearActiveRotationTimer();

    const result = await host._rotateToNewStream({ forcePlatform: platform });

    if (result.success) {
      // T4: a successful force-rotate resets the failure counter and cancels
      // (settling) any pending backoff retry — previously the stale retry
      // fired after the force-rotate and rotated a second time.
      host._recordSuccess();
      host._scheduleNextRotation();
      host._emitRotationTiming();

      if (wasLocked && host.io) {
        host.io.emit('rotation-unlocked', {
          locked: false,
          remainingMs: host.nextRotationAt - Date.now(),
          nextRotationAt: host.nextRotationAt,
          currentStream: host.currentStream,
        });
      }
    }

    return result;
  }

  // ---- extend (vote-driven) ------------------------------------------------
  extend(minutesToAdd = null) {
    const host = this.host;

    const notEnabled = this._requireEnabled();
    if (notEnabled) return notEnabled;
    const notScheduled = this._requireScheduled();
    if (notScheduled) return notScheduled;

    const cooldown = this._checkCooldown('Extend');
    if (cooldown) return cooldown;

    const extendMs = (minutesToAdd || (3 + Math.floor(Math.random() * RANDOM_EXTEND_RANGE))) * 60 * 1000;
    const extendMinutes = Math.round(extendMs / 60000);

    const remainingTime = this._remainingMs();
    if (remainingTime <= 0) return { success: false, error: 'Rotation already in progress' };

    this._clearActiveRotationTimer();

    const newInterval = remainingTime + extendMs;

    this.logger?.debug?.(`⏰ EXTEND: Adding ${extendMinutes} minutes to rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    this.lastExtendTime = Date.now();
    host._scheduleNextRotation(newInterval);

    if (host.io) {
      host.io.emit('rotation-extended', {
        extendedBy: extendMs,
        extendedByMinutes: extendMinutes,
        newNextRotationAt: host.nextRotationAt,
        currentStream: host.currentStream,
      });
    }

    return {
      success: true,
      extendedByMinutes: extendMinutes,
      newNextRotationAt: host.nextRotationAt,
      message: `Extended rotation by ${extendMinutes} minutes`,
    };
  }

  // ---- adminExtend (no cooldown) ------------------------------------------
  adminExtend(minutes = 5) {
    const host = this.host;

    const notEnabled = this._requireEnabled();
    if (notEnabled) return notEnabled;
    if (this.isLocked) return { success: false, error: 'Rotation is locked. Unlock first to extend.' };
    const notScheduled = this._requireScheduled();
    if (notScheduled) return notScheduled;

    const extendMs = minutes * 60 * 1000;
    const remainingTime = this._remainingMs();
    if (remainingTime <= 0) return { success: false, error: 'Rotation already in progress' };

    this._clearActiveRotationTimer();

    const newInterval = remainingTime + extendMs;
    this.logger?.debug?.(`⏰ ADMIN EXTEND: Adding ${minutes} minutes to rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    host._scheduleNextRotation(newInterval);

    if (host.io) {
      host.io.emit('rotation-extended', {
        extendedBy: extendMs,
        extendedByMinutes: minutes,
        newNextRotationAt: host.nextRotationAt,
        currentStream: host.currentStream,
        isAdminExtend: true,
      });
    }

    return {
      success: true,
      extendedByMinutes: minutes,
      newNextRotationAt: host.nextRotationAt,
      message: `Admin extended rotation by ${minutes} minutes`,
    };
  }

  // ---- reduce (vote-driven; shares cooldown with extend) ------------------
  reduce(minutesToSubtract = null) {
    const host = this.host;

    const notEnabled = this._requireEnabled();
    if (notEnabled) return notEnabled;
    const notScheduled = this._requireScheduled();
    if (notScheduled) return notScheduled;

    const cooldown = this._checkCooldown('Reduce');
    if (cooldown) return cooldown;

    const reduceMs = (minutesToSubtract || (3 + Math.floor(Math.random() * RANDOM_EXTEND_RANGE))) * 60 * 1000;

    const remainingTime = this._remainingMs();
    if (remainingTime <= 0) return { success: false, error: 'Rotation already in progress' };

    const newInterval = Math.max(remainingTime - reduceMs, MIN_REMAINING_MS_FLOOR);
    const actualReduction = remainingTime - newInterval;
    const actualReductionMinutes = Math.round(actualReduction / 60000 * 10) / 10;

    this._clearActiveRotationTimer();

    this.logger?.debug?.(`⏰ REDUCE: Removing ${actualReductionMinutes} minutes from rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    this.lastExtendTime = Date.now();
    host._scheduleNextRotation(newInterval);

    if (host.io) {
      host.io.emit('rotation-reduced', {
        reducedBy: actualReduction,
        reducedByMinutes: actualReductionMinutes,
        newNextRotationAt: host.nextRotationAt,
        currentRotationDuration: host.currentRotationDuration,
        serverTime: Date.now(),
        currentStream: host.currentStream,
      });
    }

    return {
      success: true,
      reducedByMinutes: actualReductionMinutes,
      newNextRotationAt: host.nextRotationAt,
      message: `Reduced rotation by ${actualReductionMinutes} minutes`,
    };
  }

  // ---- adminReduce (no cooldown) ------------------------------------------
  adminReduce(minutes = 5) {
    const host = this.host;

    const notEnabled = this._requireEnabled();
    if (notEnabled) return notEnabled;
    if (this.isLocked) return { success: false, error: 'Rotation is locked. Unlock first to reduce.' };
    const notScheduled = this._requireScheduled();
    if (notScheduled) return notScheduled;

    const reduceMs = minutes * 60 * 1000;
    const remainingTime = this._remainingMs();
    if (remainingTime <= 0) return { success: false, error: 'Rotation already in progress' };

    const newInterval = Math.max(remainingTime - reduceMs, MIN_REMAINING_MS_FLOOR);
    const actualReduction = remainingTime - newInterval;
    const actualReductionMinutes = Math.round(actualReduction / 60000 * 10) / 10;

    this._clearActiveRotationTimer();

    this.logger?.debug?.(`⏰ ADMIN REDUCE: Removing ${actualReductionMinutes} minutes from rotation. New time until switch: ${Math.round(newInterval / 60000 * 10) / 10} minutes`);

    host._scheduleNextRotation(newInterval);

    if (host.io) {
      host.io.emit('rotation-reduced', {
        reducedBy: actualReduction,
        reducedByMinutes: actualReductionMinutes,
        newNextRotationAt: host.nextRotationAt,
        currentRotationDuration: host.currentRotationDuration,
        serverTime: Date.now(),
        currentStream: host.currentStream,
        isAdminReduce: true,
      });
    }

    return {
      success: true,
      reducedByMinutes: actualReductionMinutes,
      newNextRotationAt: host.nextRotationAt,
      message: `Admin reduced rotation by ${actualReductionMinutes} minutes`,
    };
  }

  // ---- lock ---------------------------------------------------------------
  lock() {
    const host = this.host;

    const notEnabled = this._requireEnabled();
    if (notEnabled) return notEnabled;
    if (this.isLocked) return { success: false, error: 'Rotation is already locked' };
    const notScheduled = this._requireScheduled();
    if (notScheduled) return notScheduled;

    this.remainingTimeWhenLocked = this._remainingMs();
    if (this.remainingTimeWhenLocked <= 0) {
      this.remainingTimeWhenLocked = null;
      return { success: false, error: 'Rotation already in progress' };
    }

    this._clearActiveRotationTimer();

    if (host.retryState.currentRetryTimer) {
      // T4: via the host delegate so the awaited backoff promise settles.
      host._clearRetryTimer();
      this.logger?.debug?.('🔒 ROTATION: Also cleared pending retry timer');
    }

    host._clearCountdownAnnouncements();

    this.isLocked = true;
    this.lockedAt = Date.now();

    this.logger?.debug?.(`🔒 ROTATION LOCKED: Timer frozen with ${Math.round(this.remainingTimeWhenLocked / 1000)} seconds remaining`);

    if (host.io) {
      host.io.emit('rotation-locked', {
        locked: true,
        remainingMs: this.remainingTimeWhenLocked,
        currentStream: host.currentStream,
      });
    }

    return {
      success: true,
      remainingMs: this.remainingTimeWhenLocked,
      message: `Rotation locked with ${Math.round(this.remainingTimeWhenLocked / 1000)} seconds remaining`,
    };
  }

  // ---- unlock -------------------------------------------------------------
  unlock() {
    const host = this.host;

    const notEnabled = this._requireEnabled();
    if (notEnabled) return notEnabled;
    if (!this.isLocked) return { success: false, error: 'Rotation is not locked' };

    const remainingTime = this.remainingTimeWhenLocked;

    this.isLocked = false;
    this.lockedAt = null;
    this.remainingTimeWhenLocked = null;

    this.logger?.debug?.(`🔓 ROTATION UNLOCKED: Resuming timer with ${Math.round(remainingTime / 1000)} seconds remaining`);

    host._scheduleNextRotation(remainingTime);

    if (host.io) {
      host.io.emit('rotation-unlocked', {
        locked: false,
        remainingMs: remainingTime,
        nextRotationAt: host.nextRotationAt,
        currentStream: host.currentStream,
      });
    }

    return {
      success: true,
      remainingMs: remainingTime,
      nextRotationAt: host.nextRotationAt,
      message: `Rotation unlocked, resuming with ${Math.round(remainingTime / 1000)} seconds remaining`,
    };
  }

  // ---- read-side ----------------------------------------------------------
  getLockStatus() {
    return {
      isLocked: this.isLocked,
      lockedAt: this.lockedAt,
      remainingTimeWhenLocked: this.remainingTimeWhenLocked,
    };
  }

  getExtendCooldownStatus() {
    if (!this.lastExtendTime) {
      return { onCooldown: false, remainingSeconds: 0 };
    }

    const timeSinceLastExtend = Date.now() - this.lastExtendTime;
    if (timeSinceLastExtend >= this.extendCooldownMs) {
      return { onCooldown: false, remainingSeconds: 0 };
    }

    return {
      onCooldown: true,
      remainingSeconds: Math.ceil((this.extendCooldownMs - timeSinceLastExtend) / 1000),
    };
  }
}

module.exports = RotationTimerController;
