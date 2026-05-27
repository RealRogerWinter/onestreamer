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
});
