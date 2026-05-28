/**
 * RotationScheduler — owns the rotation timer, the countdown-announcement
 * timer set, and the "when does the next rotation fire" bookkeeping for
 * RandomStreamRotationService. Extracted in PR 17.3.
 *
 * State owned by this helper (was previously on the main service):
 *   rotationTimer                  — setTimeout handle for the next rotation
 *   countdownAnnouncementTimers    — [setTimeout, ...] for !extend nudges
 *   nextRotationAt                 — epoch ms when the rotation timer fires
 *   currentRotationDuration        — interval (ms) the timer was set for
 *
 * The main service keeps `this.rotationTimer`, `this.nextRotationAt`,
 * `this.currentRotationDuration`, and `this.countdownAnnouncementTimers`
 * as property accessors that proxy to the scheduler's slots so existing
 * consumers (lifecycle, manual-control verbs, getStatus, the auto-restart
 * monitor) keep working byte-equivalent.
 *
 * Behavior owned by this helper:
 *   scheduleNext(customInterval?)      — was `_scheduleNextRotation`
 *   emitRotationTiming()               — was `_emitRotationTiming`
 *   emitFullRotationStatus()           — was `_emitFullRotationStatus`
 *   clearCountdownAnnouncements()      — was `_clearCountdownAnnouncements`
 *   scheduleCountdownAnnouncements()   — was `_scheduleCountdownAnnouncements`
 *   executeRotationWithRetry()         — was `_executeRotationWithRetry`
 *
 * Cross-helper collaboration (read via `this.host.*`):
 *   host.isEnabled, host.isLocked, host.isRestarting, host.io,
 *   host.currentStream, host._rotateToNewStream(), host.sendChatAnnouncement(),
 *   host.getRandomInterval(), host._recordSuccess(), host._recordFailure(),
 *   host._scheduleRetryWithBackoff(), host.retryState.currentRetryTimer
 *
 * Loaded by RandomStreamRotationService at module-load time, constructed
 * once in the main service's constructor.
 */

class RotationScheduler {
  constructor({ host, logger }) {
    this.host = host;
    this.logger = logger;

    this.rotationTimer = null;
    this.countdownAnnouncementTimers = [];
    this.nextRotationAt = null;
    this.currentRotationDuration = null;
  }

  scheduleNext(customInterval = null) {
    const host = this.host;

    // ALWAYS clear any existing rotation timer first to prevent orphaned timers.
    if (this.rotationTimer) {
      clearTimeout(this.rotationTimer);
      this.rotationTimer = null;
    }

    const interval = customInterval !== null ? customInterval : host.getRandomInterval();
    const minutes = Math.round(interval / 60000 * 10) / 10;

    this.nextRotationAt = Date.now() + interval;
    this.currentRotationDuration = interval;

    this.logger?.debug?.(`⏱️ Next rotation in ${minutes} minutes (at ${new Date(this.nextRotationAt).toLocaleTimeString()})`);

    // Route through host so external stubs on _emitRotationTiming /
    // _scheduleCountdownAnnouncements intercept (matches pre-PR-17.3 callsite).
    host._emitRotationTiming();
    host._scheduleCountdownAnnouncements();

    // The setTimeout callback intentionally re-enters via `host._scheduleNextRotation`
    // and `host._executeRotationWithRetry` (not the scheduler's own methods) so
    // test stubs on the host instance (and any future host-level instrumentation)
    // intercept these calls. This preserves the pre-PR-17.3 behavior where the
    // body of `_scheduleNextRotation` referenced `this._executeRotationWithRetry`.
    this.rotationTimer = setTimeout(async () => {
      try {
        this.logger?.debug?.('⏰ ROTATION TIMER FIRED - executing rotation callback...');

        if (!host.isEnabled) {
          this.logger?.debug?.('⏭️ ROTATION: Skipping - rotation not enabled');
          return;
        }

        if (host.isLocked) {
          this.logger?.debug?.('🔒 ROTATION: Skipping scheduled rotation - timer is locked');
          return; // Don't reschedule - will resume when unlocked.
        }

        if (host.isRestarting) {
          this.logger?.debug?.('⏳ ROTATION: Skipping scheduled rotation - restart in progress');
          host._scheduleNextRotation();
          return;
        }

        await host._executeRotationWithRetry();
      } catch (error) {
        this.logger?.error?.('❌ ROTATION TIMER ERROR:', error.message);
        this.logger?.error?.(error.stack);

        if (host.isEnabled && !host.isLocked) {
          this.logger?.debug?.('🔄 ROTATION: Rescheduling after error...');
          host._scheduleNextRotation();
        }
      }
    }, interval);
  }

  emitRotationTiming() {
    const host = this.host;
    if (host.io && host.isEnabled) {
      host.io.emit('rotation-timing', {
        nextRotationAt: this.nextRotationAt,
        currentRotationDuration: this.currentRotationDuration,
        serverTime: Date.now(),
      });
    }
  }

  emitFullRotationStatus() {
    const host = this.host;
    if (host.io && host.isEnabled && host.currentStream) {
      this.logger?.debug?.('📡 EMITTING full rotation status with timing');
      host.io.emit('random-rotation-status', {
        enabled: true,
        currentStream: host.currentStream,
        rotationTiming: {
          nextRotationAt: this.nextRotationAt,
          currentRotationDuration: this.currentRotationDuration,
          serverTime: Date.now(),
        },
      });
    }
  }

  clearCountdownAnnouncements() {
    this.countdownAnnouncementTimers.forEach((timer) => clearTimeout(timer));
    this.countdownAnnouncementTimers = [];
  }

  scheduleCountdownAnnouncements() {
    const host = this.host;

    this.clearCountdownAnnouncements();

    if (!this.nextRotationAt || !host.isEnabled) return;

    const remainingMs = this.nextRotationAt - Date.now();

    // Time-remaining thresholds + their candidate messages. Multiple
    // strings per threshold so we don't sound mechanical in chat.
    const announcements = [
      {
        timeRemaining: 180000, // 3 minutes
        messages: [
          "📺 3 minutes until we switch! Use !extend to add more time or !next to skip ahead!",
          "⏰ Stream switching in 3 minutes! Like it? !extend to stay. Bored? !next to skip!",
          "🎬 3 min warning! Vote !extend to keep watching or !next to find something new!",
        ],
      },
      {
        timeRemaining: 60000, // 1 minute
        messages: [
          "⚠️ 1 minute left! Quick - use !extend to keep watching or !next to skip to something new!",
          "🔔 60 seconds! Vote !extend to add time, !next to skip, or !lock to freeze the timer!",
          "⏰ Final minute! Enjoying this stream? !extend to stay, !next to move on!",
        ],
      },
      {
        timeRemaining: 30000, // 30 seconds
        messages: [
          "🚨 30 seconds! Last chance to !extend or !lock if you want to keep watching!",
          "⚡ 30 sec warning! !extend to add time, !next to skip now!",
          "⏱️ Switching soon! Use !extend, !next, or !lock before time runs out!",
        ],
      },
    ];

    announcements.forEach((announcement) => {
      const delay = remainingMs - announcement.timeRemaining;

      if (delay > 0) {
        const timer = setTimeout(() => {
          if (host.isLocked || !host.isEnabled) return;

          const message = announcement.messages[Math.floor(Math.random() * announcement.messages.length)];
          host.sendChatAnnouncement(message);
        }, delay);

        this.countdownAnnouncementTimers.push(timer);
      }
    });

    this.logger?.debug?.(`📢 Scheduled ${this.countdownAnnouncementTimers.length} countdown announcements`);
  }

  async executeRotationWithRetry() {
    const host = this.host;

    if (!host.isEnabled) return;

    if (host.isLocked) {
      this.logger?.debug?.('🔒 ROTATION: Skipping rotation - timer is locked');
      return;
    }

    const result = await host._rotateToNewStream();

    if (result.success) {
      host._recordSuccess();
      // Route through host so external stubs on _scheduleNextRotation /
      // _emitFullRotationStatus intercept; preserves pre-PR-17.3 callsite.
      host._scheduleNextRotation();
      host._emitFullRotationStatus();
    } else {
      host._recordFailure();
      this.logger?.debug?.(`⚠️ ROTATION: Failed (${host.retryState.consecutiveFailures} consecutive failures): ${result.error}`);

      await host._scheduleRetryWithBackoff(
        () => host._executeRotationWithRetry(),
        'scheduled rotation'
      );

      // If we get here and rotation is still enabled but nothing is armed,
      // reschedule defensively (same recovery branch as pre-PR).
      if (host.isEnabled && !this.rotationTimer && !host.retryState.currentRetryTimer) {
        this.logger?.debug?.('⚠️ ROTATION: No timer active after retry - rescheduling...');
        host._scheduleNextRotation();
      }
    }
  }
}

module.exports = RotationScheduler;
