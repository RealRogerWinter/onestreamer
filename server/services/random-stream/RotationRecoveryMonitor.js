/**
 * RotationRecoveryMonitor — the 5-second auto-restart/recovery polling loop
 * + the "is there a real streamer?" global query. Extracted from
 * RandomStreamRotationService in PR 17.5.
 *
 * Owns the `autoRestartMonitor` setInterval handle (the main service
 * re-exposes it via a property accessor so `stop()` keeps clearing it
 * through `this.autoRestartMonitor`). The polling check is byte-equivalent
 * to the pre-PR `_startAutoRestartMonitor` body — same 5 s base interval,
 * same busy/real-streamer/backoff short-circuits, same three recovery
 * branches (auto-restart-when-disabled, dead-stream recovery via
 * `_rotateToNewStream`, reschedule-when-timer-lost), same log strings.
 *
 * Cross-service collaboration via `this.host.*`:
 *   host.isRestarting, host.retryState, host.viewBotURLService,
 *   host.shouldAutoRestart, host.isEnabled, host.rotationTimer,
 *   host.isLocked, host.nextRotationAt
 *   host.start(), host._recordSuccess(), host._recordFailure(),
 *   host._calculateRetryDelay(), host._rotateToNewStream(),
 *   host._scheduleNextRotation()
 *   global.streamService (real-streamer query)
 *
 * The shared `logger` is the RandomStreamRotationService child, so log
 * lines keep their `svc: 'RandomStreamRotationService'` binding.
 */

class RotationRecoveryMonitor {
    constructor({ host, logger }) {
        this.host = host;
        this.logger = logger;
        this.autoRestartMonitor = null;
    }

    setupStreamEndedListener() {
        // Listen on the io instance for when any stream ends
        // We'll hook into the global streamService instead
        if (global.streamService) {
            // Poll periodically to check if stream ended and we should restart
            this.startAutoRestartMonitor();
        }
    }

    startAutoRestartMonitor() {
        const host = this.host;
        const logger = this.logger;

        // Dynamic check interval - increases on failures, resets on success
        const baseInterval = 5000;  // 5 seconds base
        const maxInterval = 60000;  // 1 minute max

        if (this.autoRestartMonitor) {
            clearInterval(this.autoRestartMonitor);
        }

        const runMonitorCheck = async () => {
            // Skip if already processing or a retry timer is pending
            if (host.isRestarting || host.retryState.currentRetryTimer) return;

            // CRITICAL: Check if ViewBotURLService is busy (starting or reconnecting)
            if (host.viewBotURLService && host.viewBotURLService.isBusy()) {
                return; // Don't interfere while service is busy
            }

            // Check if there's currently a real streamer
            const hasRealStreamer = this.hasRealStreamer();
            if (hasRealStreamer) {
                // Reset failure count when real streamer is active
                if (host.retryState.consecutiveFailures > 0) {
                    host._recordSuccess();
                }
                return;
            }

            // Case 1: Should auto-restart but not enabled (shouldn't happen often with new logic)
            if (host.shouldAutoRestart && !host.isEnabled) {
                logger.debug('🔄 No active streamer detected, auto-restarting random rotation...');
                host.isRestarting = true;
                try {
                    await host.start();
                    host._recordSuccess();
                } catch (error) {
                    logger.error('❌ Auto-restart failed:', error.message);
                    host._recordFailure();
                } finally {
                    host.isRestarting = false;
                }
                return;
            }

            // Case 2: Rotation is enabled but no URL stream is actually active (dead stream detection)
            if (host.isEnabled && host.viewBotURLService) {
                const activeStreamCount = host.viewBotURLService.activeStreams.size;

                // Also check if rotation timer exists - if not, we may have lost state
                const hasRotationTimer = host.rotationTimer !== null || host.retryState.currentRetryTimer !== null;

                if (activeStreamCount === 0) {
                    // Check backoff - don't retry too fast after failures
                    const timeSinceLastFailure = host.retryState.lastFailureTime
                        ? Date.now() - host.retryState.lastFailureTime
                        : Infinity;
                    const requiredBackoff = host._calculateRetryDelay();

                    if (timeSinceLastFailure < requiredBackoff) {
                        // Still in backoff period, skip this check
                        return;
                    }

                    logger.debug(`⚠️ ROTATION: Enabled but no active URL stream (failures: ${host.retryState.consecutiveFailures}) - starting recovery...`);
                    host.isRestarting = true;
                    try {
                        const result = await host._rotateToNewStream();
                        if (result.success) {
                            logger.debug(`✅ ROTATION: Recovery successful: ${result.stream?.displayName}`);
                            host._recordSuccess();

                            // CRITICAL: Ensure rotation timer is scheduled after recovery
                            if (!host.rotationTimer) {
                                host._scheduleNextRotation();
                            }
                        } else {
                            logger.error(`❌ ROTATION: Recovery failed: ${result.error}`);
                            host._recordFailure();
                        }
                    } catch (error) {
                        logger.error('❌ ROTATION: Recovery error:', error.message);
                        host._recordFailure();
                    } finally {
                        host.isRestarting = false;
                    }
                } else if (!hasRotationTimer && activeStreamCount > 0) {
                    // Stream is active but no rotation timer - reschedule
                    logger.debug('⚠️ ROTATION: Stream active but no rotation timer detected!');
                    logger.debug(`   - rotationTimer: ${host.rotationTimer ? 'set' : 'null'}`);
                    logger.debug(`   - currentRetryTimer: ${host.retryState.currentRetryTimer ? 'set' : 'null'}`);
                    logger.debug(`   - isLocked: ${host.isLocked}`);
                    logger.debug(`   - nextRotationAt: ${host.nextRotationAt ? new Date(host.nextRotationAt).toLocaleTimeString() : 'null'}`);
                    logger.debug('🔄 ROTATION: Rescheduling timer to recover...');
                    host._scheduleNextRotation();
                }
            }
        };

        // Run check on interval
        this.autoRestartMonitor = setInterval(runMonitorCheck, baseInterval);

        logger.debug('👁️ Auto-restart monitor started (with exponential backoff)');
    }

    hasRealStreamer() {
        if (!global.streamService) return false;

        const currentStreamer = global.streamService.getCurrentStreamer();
        if (!currentStreamer) return false;

        // URL streams and viewbots are not "real" streamers
        if (currentStreamer.startsWith('url-stream-')) return false;
        if (currentStreamer.startsWith('viewbot-')) return false;
        if (currentStreamer.includes('viewbot')) return false;

        // There's a real streamer
        return true;
    }
}

module.exports = RotationRecoveryMonitor;
