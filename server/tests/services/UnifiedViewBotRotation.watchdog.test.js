/**
 * PR 8.2 (Phase 8) — tick-loop watchdog for UnifiedViewBotRotation.
 *
 * Tests the observability-only watchdog added in ADR-0016. The watchdog
 * reads `activeRotation.lastTickAt` (set by the sub-rotations at the
 * entry of every `rotateToNextBot()` call) and logs a level:error event
 * when the loop has not ticked within `maxRotationInterval * 2`.
 *
 * The watchdog does NOT restart anything; pm2 (or equivalent supervisor)
 * is the recovery agent. The tests assert only the logging behavior and
 * the lifecycle (cleared on stop, not fired when not started, etc.).
 */

const UnifiedViewBotRotation = require('../../services/UnifiedViewBotRotation');

// Stub for `this.activeRotation`. The real plainrtp / webrtc sub-rotation
// classes are heavyweight; the watchdog only reads `lastTickAt` and
// `settings.maxRotationInterval`, plus calls `startRotation()` /
// `stopRotation()` via the wrapper.
function makeFakeActiveRotation({ lastTickAt = null, maxRotationInterval = 180000 } = {}) {
    return {
        lastTickAt,
        settings: { maxRotationInterval },
        async startRotation() {},
        async stopRotation() {},
        async shutdown() {},
        getStatus() { return { currentBot: null }; },
        updateSettings() {},
    };
}

function makeLogger() {
    return {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        log: jest.fn(),
    };
}

function buildOrchestrator({ now, watchdogCheckMs = 100, logger } = {}) {
    // io / streamService / mediasoupService / livekitService can be null —
    // the watchdog code path does not reach them.
    return new UnifiedViewBotRotation(
        null,
        null,
        null,
        null,
        null,
        {
            watchdogCheckMs,
            watchdogLogger: logger,
            now: now,
        }
    );
}

describe('UnifiedViewBotRotation watchdog (PR 8.2 — ADR-0016)', () => {
    let clock;
    let consoleLogSpy;
    let consoleErrorSpy;

    beforeEach(() => {
        clock = { ms: 1_000_000 };
        // Silence the chatty console.log inside UnifiedViewBotRotation; the
        // watchdog uses its own injected logger so we can still assert.
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
    });

    function advanceClock(ms) {
        clock.ms += ms;
        jest.advanceTimersByTime(ms);
    }

    it('fires level:error when lastTickAt is older than maxRotationInterval * 2', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000, // threshold = 2000 ms
        });

        await orch.startRotation();

        // Simulate the tick chain wedging: lastTickAt never updates.
        advanceClock(2500);

        expect(logger.error).toHaveBeenCalled();
        const [msg, ctx] = logger.error.mock.calls[0];
        expect(msg).toMatch(/has not ticked/);
        expect(ctx).toMatchObject({
            level: 'error',
            event: 'viewbot-rotation-stalled',
            mode: 'plainrtp',
            thresholdMs: 2000,
            maxRotationIntervalMs: 1000,
            isRotating: true,
        });
        expect(ctx.sinceLastTickMs).toBeGreaterThan(2000);

        await orch.stopRotation();
    });

    it('does NOT fire when lastTickAt is within threshold', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        const active = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });
        orch.activeRotation = active;

        await orch.startRotation();

        // Advance, but keep lastTickAt fresh (as a real loop would).
        for (let i = 0; i < 10; i++) {
            advanceClock(100);
            active.lastTickAt = clock.ms;
        }

        expect(logger.error).not.toHaveBeenCalled();

        await orch.stopRotation();
    });

    it('does NOT fire before the first tick has recorded (lastTickAt null)', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.activeRotation = makeFakeActiveRotation({ lastTickAt: null, maxRotationInterval: 1000 });

        await orch.startRotation();

        // Loop hasn't ticked yet; watchdog should be tolerant during warmup.
        advanceClock(5000);

        expect(logger.error).not.toHaveBeenCalled();

        await orch.stopRotation();
    });

    it('does NOT fire when rotation is not started (isRotating=false)', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        // Manually attach an activeRotation with a stale tick, but never call startRotation.
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms - 1_000_000,
            maxRotationInterval: 1000,
        });

        // No watchdog was started → no interval is ticking. Confirm nothing logs.
        advanceClock(5000);

        expect(logger.error).not.toHaveBeenCalled();
    });

    it('clears the watchdog interval on stopRotation (no fire after stop)', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });

        await orch.startRotation();
        await orch.stopRotation();

        // Without the watchdog running, even a long wedge produces no logs.
        advanceClock(10_000);

        expect(logger.error).not.toHaveBeenCalled();
        // The handle should be cleared.
        expect(orch.watchdogInterval).toBeNull();
    });

    it('clears the watchdog on shutdown', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });
        // Also wire the sub-rotations so shutdown() doesn't NPE.
        orch.plainRtpRotation = orch.activeRotation;
        orch.webRtcRotation = makeFakeActiveRotation();

        await orch.startRotation();
        await orch.shutdown();

        advanceClock(10_000);

        expect(logger.error).not.toHaveBeenCalled();
        expect(orch.watchdogInterval).toBeNull();
    });

    it('does NOT restart the rotation — only logs (no side effects on activeRotation)', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        const active = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });
        active.startRotation = jest.fn(active.startRotation);
        active.stopRotation = jest.fn(active.stopRotation);
        orch.activeRotation = active;

        await orch.startRotation();
        active.startRotation.mockClear(); // ignore the initial call

        // Trip the watchdog.
        advanceClock(3000);

        expect(logger.error).toHaveBeenCalled();
        // CRUCIAL: the watchdog must NOT call start/stop on the sub-rotation.
        // Restarting on top of a still-hung promise just queues a second
        // hung promise (per the Phase 8 red-team finding).
        expect(active.startRotation).not.toHaveBeenCalled();
        expect(active.stopRotation).not.toHaveBeenCalled();

        await orch.stopRotation();
    });

    it('context includes mode + backend so structured-log filters can distinguish', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.mode = 'webrtc';
        orch.backendType = 'livekit';
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });

        await orch.startRotation();
        advanceClock(3000);

        expect(logger.error).toHaveBeenCalled();
        const ctx = logger.error.mock.calls[0][1];
        expect(ctx.mode).toBe('webrtc');
        expect(ctx.backend).toBe('livekit');

        await orch.stopRotation();
    });

    it('SimpleViewBotRotation has a lastTickAt property initialized to null', () => {
        // The watchdog reads `activeRotation.lastTickAt`; this ensures the
        // contract on the plain-RTP side is honored.
        const SimpleViewBotRotation = require('../../services/SimpleViewBotRotation');
        // SimpleViewBotRotation is exported as a singleton instance.
        expect(SimpleViewBotRotation).toHaveProperty('lastTickAt');
        // It may be null (no tick yet) or a number (a previous test
        // populated it via require cache).
        expect(
            SimpleViewBotRotation.lastTickAt === null ||
            typeof SimpleViewBotRotation.lastTickAt === 'number'
        ).toBe(true);
    });

    it('WebRTCViewBotRotation has a lastTickAt property initialized to null', () => {
        const WebRTCViewBotRotation = require('../../services/WebRTCViewBotRotation');
        const instance = new WebRTCViewBotRotation(null, null, null);
        expect(instance.lastTickAt).toBeNull();
    });

    // ============================================================
    // PR 13.2 (Phase 13) — additional edge cases.
    // ============================================================

    it('fires on EVERY consecutive watchdog check while stalled (not one-shot)', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000, // threshold = 2000 ms
        });

        await orch.startRotation();

        // Stall the loop.
        clock.ms += 2500;
        // Trip the watchdog three times in a row at the 50 ms cadence.
        jest.advanceTimersByTime(150);

        // Operationally this matters because alerting pipelines deduplicate
        // by event identity, not by single-fire — and the runbook says
        // "rate of 'viewbot-rotation-stalled' events tells you the loop
        // is wedged vs intermittently slow." Single-firing would mask that.
        expect(logger.error.mock.calls.length).toBeGreaterThanOrEqual(3);
        for (const call of logger.error.mock.calls) {
            const [, ctx] = call;
            expect(ctx.event).toBe('viewbot-rotation-stalled');
        }

        await orch.stopRotation();
    });

    it('log context includes realStreamerActive=false when no real streamer is on', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.plainRtpRotation = {
            isRealStreamerActive: jest.fn(() => false),
        };
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });

        await orch.startRotation();
        advanceClock(3000);

        expect(logger.error).toHaveBeenCalled();
        const ctx = logger.error.mock.calls[0][1];
        expect(ctx.realStreamerActive).toBe(false);
        expect(orch.plainRtpRotation.isRealStreamerActive).toHaveBeenCalled();

        await orch.stopRotation();
    });

    it('log context includes realStreamerActive=true when a real streamer (or URL stream) is on', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.plainRtpRotation = {
            isRealStreamerActive: jest.fn(() => true),
        };
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });

        await orch.startRotation();
        advanceClock(3000);

        expect(logger.error).toHaveBeenCalled();
        const ctx = logger.error.mock.calls[0][1];
        // This is the "blocked by design" hint from the runbook — separates
        // "code bug wedged the loop" from "real streamer is on, loop is
        // correctly idle waiting for them to leave."
        expect(ctx.realStreamerActive).toBe(true);

        await orch.stopRotation();
    });

    it('tolerates plainRtpRotation.isRealStreamerActive throwing (defensive try/catch keeps the watchdog alive)', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.plainRtpRotation = {
            isRealStreamerActive: jest.fn(() => { throw new Error('boom'); }),
        };
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });

        await orch.startRotation();
        advanceClock(3000);

        // Watchdog still fires (the throw is swallowed); realStreamerActive
        // defaults to false when the helper failed. Without the try/catch
        // the watchdog itself would error and stop logging — strictly worse.
        expect(logger.error).toHaveBeenCalled();
        const ctx = logger.error.mock.calls[0][1];
        expect(ctx.realStreamerActive).toBe(false);

        await orch.stopRotation();
    });

    it('does NOT fire when activeRotation is null mid-flight (e.g., raced reassignment)', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        orch.activeRotation = makeFakeActiveRotation({
            lastTickAt: clock.ms,
            maxRotationInterval: 1000,
        });

        await orch.startRotation();

        // Simulate the swap: orchestrator clears activeRotation mid-flight
        // (e.g., a mode toggle is in progress). The watchdog's `if
        // (!this.isRotating || !this.activeRotation) return;` guard must
        // catch this — otherwise the next tick would NPE on
        // `this.activeRotation.lastTickAt`.
        orch.activeRotation = null;
        advanceClock(5000);

        expect(logger.error).not.toHaveBeenCalled();

        await orch.stopRotation();
    });

    it('uses default maxRotationInterval=180000 when activeRotation.settings is absent', async () => {
        const logger = makeLogger();
        const orch = buildOrchestrator({ now: () => clock.ms, watchdogCheckMs: 50, logger });
        // Mimic an old/incomplete sub-rotation shape with no `settings`.
        orch.activeRotation = {
            lastTickAt: clock.ms,
            // no settings property
            async startRotation() {}, async stopRotation() {}, async shutdown() {},
            getStatus() { return {}; }, updateSettings() {},
        };

        await orch.startRotation();
        // Default threshold is 180_000 * 2 = 360_000 ms. Advance just past it.
        advanceClock(365_000);

        expect(logger.error).toHaveBeenCalled();
        const ctx = logger.error.mock.calls[0][1];
        expect(ctx.maxRotationIntervalMs).toBe(180000);
        expect(ctx.thresholdMs).toBe(360000);

        await orch.stopRotation();
    });
});
