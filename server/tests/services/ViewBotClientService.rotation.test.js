/**
 * ViewBotClientService rotation state machine — CHARACTERIZATION tests.
 *
 * Purpose: pin the OBSERVABLE behavior of the rotation methods on
 * ViewBotClientService.js BEFORE the upcoming ViewBotRotationController
 * extraction. These are a safety net: they assert what the CURRENT code does
 * (return shapes, state transitions, queue contents, collaborator calls), not
 * what it "should" do. Adjust only if the production behavior changes.
 *
 * Methods covered:
 *   - handleRotationRequest  (gating on rotationEnabled / realStreamerActive +
 *                             the no-available-bots and happy-path branches)
 *   - queueRotationRequest   (enqueue + single process timer)
 *   - processRotationQueue   (lock reschedule, drain, streaming filter, FIFO
 *                             selection, empty/early-return)
 *   - handleRotation         (delegates to queueRotationRequest 'video-end')
 *   - handleVideoEnd         (stop + clear currentLiveBot + delayed rotation)
 *   - stopViewBotRotation    (stops current bot, clears currentLiveBot/timer)
 *   - forceRotation          (gating + queue path)
 *   - manualTriggerTakeover  (gating + startViewBotRotation path)
 *   - scheduleViewBotTakeover(timer scheduling + double-check on fire)
 *   - maintainViewBotPresence(gating short-circuits)
 *   - restartRotationAfterRestore (observable startViewBotRotation path)
 *
 * Construction strategy mirrors
 * ViewBotClientService.updateRotationSettings.test.js: mock the heavy
 * sub-services, stub fs for the rotation config (routed to /tmp), run under
 * fake timers, stub the spawn-backed FFmpeg detector, and clear timers in
 * afterEach so no handles leak.
 */

jest.mock('../../services/ViewBotDatabaseService', () => {
    return class ViewBotDatabaseServiceStub {
        constructor() { this.initialized = false; }
        async initialize() { this.initialized = true; }
        async getAllBots() { return []; }
        async getSystemState() { return {}; }
        async saveSystemState() {}
        async recordRotation() {}
    };
});

jest.mock('../../services/ProcessManager', () => ({
    killBotProcesses: jest.fn(async () => {}),
    registerProcess: jest.fn(),
    reapAll: jest.fn(async () => ({ tracked: 0 })),
    stop: jest.fn(async () => {}),
}));

jest.mock('../../services/ViewBotStateManager', () => ({
    getViewBotState: jest.fn(() => ({})),
    setViewBotState: jest.fn(),
    clearViewBotState: jest.fn(),
}));

// fs writes: route rotation config to /tmp so the test can't accidentally
// corrupt the real viewbot-rotation-config.json next to the server.
const fs = require('fs');
let configContents = null;

const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
const originalExistsSync = fs.existsSync;

beforeAll(() => {
    fs.readFileSync = jest.fn((p, ...rest) => {
        if (typeof p === 'string' && p.endsWith('viewbot-rotation-config.json')) {
            return configContents || '{}';
        }
        return originalReadFileSync(p, ...rest);
    });
    fs.writeFileSync = jest.fn((p, data) => {
        if (typeof p === 'string' && p.endsWith('viewbot-rotation-config.json')) {
            configContents = data;
            return;
        }
        return originalWriteFileSync(p, data);
    });
    fs.existsSync = jest.fn((p) => {
        if (typeof p === 'string' && p.endsWith('viewbot-rotation-config.json')) {
            return configContents !== null;
        }
        return originalExistsSync(p);
    });
});

afterAll(() => {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.existsSync = originalExistsSync;
});

const ViewBotClientService = require('../../services/ViewBotClientService');

// Stub the spawn-backed FFmpeg detector before any constructor runs (the real
// detector spawns `ffmpeg -version`; under fake timers its kill timeout never
// fires and the child keeps Jest's handle open).
ViewBotClientService.checkFFmpegAvailability = jest.fn(async () => ({
    available: true,
    path: '/usr/bin/ffmpeg',
}));

/**
 * Build a fake ViewBotInstance shaped to match what the rotation code reads:
 * `.streaming`, `.isConnected`, `.botId`, `.isStreaming()`, `.stopStreaming()`,
 * `.startStreaming()`, `.startRotationCheckTimer()`, `.cleanupMediaGeneration()`,
 * and `.socket`.
 */
function fakeBot(botId, overrides = {}) {
    return {
        botId,
        streaming: false,
        isConnected: true,
        isPlaceholder: false,
        lazyLoad: false,
        socket: null,
        sessionStartTime: Date.now(),
        isStreaming: jest.fn(function () { return this.streaming; }),
        stopStreaming: jest.fn(async () => {}),
        startStreaming: jest.fn(async () => {}),
        startRotationCheckTimer: jest.fn(),
        cleanupMediaGeneration: jest.fn(),
        ...overrides,
    };
}

describe('ViewBotClientService rotation state machine (characterization)', () => {
    let svc;

    beforeEach(() => {
        configContents = null;
        jest.useFakeTimers();
        svc = new ViewBotClientService(null, null, null, null);
        // The constructor fires initialize() (async, swallowed) and sets
        // long-lived intervals. The rotation methods under test don't depend on
        // DB/state, so we just neutralize the bits the methods touch.
        svc.initializationInProgress = false;
        svc.dbInitialized = false;
    });

    afterEach(() => {
        if (svc && typeof svc.stopAutoValidation === 'function') {
            try { svc.stopAutoValidation(); } catch (_) {}
        }
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 1: handleRotationRequest GATING
    // ───────────────────────────────────────────────────────────────────────
    describe('handleRotationRequest — gating', () => {
        it('resolves {success:false, "Rotation is disabled"} and does not rotate when rotationEnabled is false', async () => {
            svc.rotationEnabled = false;
            svc.realStreamerActive = false;
            const stop = jest.fn();
            svc.activeBots.set('b1', fakeBot('b1', { streaming: true, stopStreaming: stop }));

            const result = await svc.handleRotationRequest('b1', 'video-end');

            expect(result).toEqual({ success: false, message: 'Rotation is disabled' });
            expect(stop).not.toHaveBeenCalled();
        });

        it('resolves {success:false, "Real streamer is active"} when realStreamerActive is true', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = true;

            const result = await svc.handleRotationRequest('b1', 'video-end');

            expect(result).toEqual({ success: false, message: 'Real streamer is active' });
        });

        it('returns {success:false, "No available ViewBots for rotation"} and clears currentLiveBot when nothing is available', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = 'b1';
            // Only the requesting bot exists and it is streaming → filtered out
            // (the filter requires !bot.streaming for the *next* candidate).
            svc.activeBots.set('b1', fakeBot('b1', { streaming: true }));

            const result = await svc.handleRotationRequest('b1', 'video-end');

            expect(result).toEqual({ success: false, message: 'No available ViewBots for rotation' });
            expect(svc.currentLiveBot).toBeNull();
        });

        it('happy path: stops current bot, starts next, updates currentLiveBot, returns previous/new/reason', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = 'b1';
            const current = fakeBot('b1', { streaming: true });
            const next = fakeBot('b2', { streaming: false, isConnected: true });
            svc.activeBots.set('b1', current);
            svc.activeBots.set('b2', next);
            // Make selection deterministic.
            svc.selectViewBotWithCooldown = jest.fn(() => next);
            const applyCooldown = jest.spyOn(svc, 'applyBotCooldown');

            const p = svc.handleRotationRequest('b1', 'forced');
            // handleRotationRequest awaits an internal 1000ms cleanup delay.
            await jest.advanceTimersByTimeAsync(1000);
            const result = await p;

            expect(current.stopStreaming).toHaveBeenCalled();
            expect(next.startStreaming).toHaveBeenCalled();
            expect(next.startRotationCheckTimer).toHaveBeenCalled();
            expect(applyCooldown).toHaveBeenCalledWith('b2');
            expect(svc.currentLiveBot).toBe('b2');
            expect(result).toEqual({
                success: true,
                previousBot: 'b1',
                newBot: 'b2',
                reason: 'forced',
            });
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 2: queueRotationRequest
    // ───────────────────────────────────────────────────────────────────────
    describe('queueRotationRequest', () => {
        beforeEach(() => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
        });

        it('enqueues via rotationRequestQueue and returns the queue success shape', () => {
            const enqueueSpy = jest.spyOn(svc.rotationRequestQueue, 'enqueue');

            const result = svc.queueRotationRequest('b1', 'video-end');

            expect(enqueueSpy).toHaveBeenCalledWith('b1', 'video-end', {
                rotationEnabled: true,
                realStreamerActive: false,
            });
            expect(result).toEqual({ success: true, message: 'Rotation request queued' });
            expect(svc.rotationRequestQueue.length).toBe(1);
        });

        it('starts exactly one rotationProcessTimer even when called twice before the window elapses', () => {
            svc.queueRotationRequest('b1', 'video-end');
            const firstTimer = svc.rotationProcessTimer;
            expect(firstTimer).not.toBeNull();

            // A second DISTINCT bot is queued (same-bot dedups in the queue).
            svc.queueRotationRequest('b2', 'video-end');

            // Still the same single timer handle — not a second setTimeout.
            expect(svc.rotationProcessTimer).toBe(firstTimer);
            expect(svc.rotationRequestQueue.length).toBe(2);
        });

        it('does not start a timer when the queue rejects the request (e.g. rotation disabled)', () => {
            svc.rotationEnabled = false;
            const result = svc.queueRotationRequest('b1', 'video-end');
            expect(result).toEqual({ success: false, message: 'Rotation is disabled' });
            expect(svc.rotationProcessTimer).toBeNull();
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 3: processRotationQueue
    // ───────────────────────────────────────────────────────────────────────
    describe('processRotationQueue', () => {
        beforeEach(() => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
        });

        it('reschedules (does not process) when rotationLock is held', async () => {
            svc.rotationLock = true;
            const drainSpy = jest.spyOn(svc.rotationRequestQueue, 'drain');

            await svc.processRotationQueue();

            expect(drainSpy).not.toHaveBeenCalled();
            // A reschedule timer was armed.
            expect(svc.rotationProcessTimer).not.toBeNull();
        });

        it('returns early when the queue is empty', async () => {
            const handleSpy = jest.spyOn(svc, 'handleRotationRequest');
            await svc.processRotationQueue();
            expect(handleSpy).not.toHaveBeenCalled();
        });

        it('drains the queue and returns early when no request maps to a streaming bot', async () => {
            // Queue a request whose bot is absent / not streaming.
            svc.activeBots.set('b1', fakeBot('b1', { streaming: false }));
            svc.rotationRequestQueue.enqueue('b1', 'video-end', {
                rotationEnabled: true, realStreamerActive: false,
            });
            const handleSpy = jest.spyOn(svc, 'handleRotationRequest');

            await svc.processRotationQueue();

            // Queue was drained regardless of validity.
            expect(svc.rotationRequestQueue.length).toBe(0);
            expect(handleSpy).not.toHaveBeenCalled();
        });

        it('FIFO-selects exactly one valid (streaming) request and calls handleRotationRequest with it', async () => {
            // b1 not streaming (invalid), b2 streaming (valid, but second),
            // b3 streaming (valid, but third). Insert a streaming bot FIRST so
            // FIFO picks it.
            svc.activeBots.set('bA', fakeBot('bA', { streaming: true }));
            svc.activeBots.set('bB', fakeBot('bB', { streaming: false }));
            svc.activeBots.set('bC', fakeBot('bC', { streaming: true }));
            svc.rotationRequestQueue.enqueue('bA', 'video-end', { rotationEnabled: true, realStreamerActive: false });
            svc.rotationRequestQueue.enqueue('bB', 'video-end', { rotationEnabled: true, realStreamerActive: false });
            svc.rotationRequestQueue.enqueue('bC', 'video-end', { rotationEnabled: true, realStreamerActive: false });

            // Stub handleRotationRequest so we only observe the selection, and
            // so the lock-release path is deterministic.
            const handleSpy = jest.spyOn(svc, 'handleRotationRequest')
                .mockResolvedValue({ success: true });

            await svc.processRotationQueue();

            expect(handleSpy).toHaveBeenCalledTimes(1);
            // First *valid* (streaming) request in FIFO order is bA.
            expect(handleSpy).toHaveBeenCalledWith('bA', 'video-end');
            // Lock released after processing.
            expect(svc.rotationLock).toBe(false);
        });

        it('releases the rotationLock even when handleRotationRequest throws', async () => {
            svc.activeBots.set('bA', fakeBot('bA', { streaming: true }));
            svc.rotationRequestQueue.enqueue('bA', 'video-end', { rotationEnabled: true, realStreamerActive: false });
            jest.spyOn(svc, 'handleRotationRequest').mockRejectedValue(new Error('boom'));

            await svc.processRotationQueue();

            expect(svc.rotationLock).toBe(false);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 4: handleRotation delegates to queueRotationRequest('video-end')
    // ───────────────────────────────────────────────────────────────────────
    describe('handleRotation', () => {
        it("delegates to queueRotationRequest(botId, 'video-end')", () => {
            const queueSpy = jest.spyOn(svc, 'queueRotationRequest').mockReturnValue({ success: true });
            svc.handleRotation('b1');
            expect(queueSpy).toHaveBeenCalledWith('b1', 'video-end');
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 5: handleVideoEnd
    // ───────────────────────────────────────────────────────────────────────
    describe('handleVideoEnd', () => {
        it('returns early (no stop) when the bot is absent', async () => {
            await expect(svc.handleVideoEnd('nope')).resolves.toBeUndefined();
        });

        it('returns early when the bot exists but is not streaming', async () => {
            const bot = fakeBot('b1', { streaming: false });
            svc.activeBots.set('b1', bot);
            await svc.handleVideoEnd('b1');
            expect(bot.stopStreaming).not.toHaveBeenCalled();
        });

        it('stops the streaming bot and clears currentLiveBot when it matches', async () => {
            svc.rotationEnabled = false; // avoid the delayed-rotation branch
            svc.realStreamerActive = false;
            const bot = fakeBot('b1', { streaming: true });
            svc.activeBots.set('b1', bot);
            svc.currentLiveBot = 'b1';

            await svc.handleVideoEnd('b1');

            expect(bot.stopStreaming).toHaveBeenCalled();
            expect(svc.currentLiveBot).toBeNull();
        });

        it('schedules a delayed startViewBotRotation when rotation is enabled and a bot is available', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            const ending = fakeBot('b1', { streaming: true });
            const idle = fakeBot('b2', { streaming: false, isConnected: true });
            svc.activeBots.set('b1', ending);
            svc.activeBots.set('b2', idle);
            svc.currentLiveBot = 'b1';
            const startSpy = jest.spyOn(svc, 'startViewBotRotation').mockResolvedValue(undefined);

            await svc.handleVideoEnd('b1');
            // currentLiveBot cleared synchronously after stop.
            expect(svc.currentLiveBot).toBeNull();
            // The post-cleanup rotation is behind a 3000ms timer.
            expect(startSpy).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(3000);
            expect(startSpy).toHaveBeenCalled();
        });

        it('does NOT schedule rotation when a real streamer becomes active', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = true; // gate the delayed branch out
            const bot = fakeBot('b1', { streaming: true });
            svc.activeBots.set('b1', bot);
            svc.currentLiveBot = 'b1';
            const startSpy = jest.spyOn(svc, 'startViewBotRotation').mockResolvedValue(undefined);

            await svc.handleVideoEnd('b1');
            await jest.advanceTimersByTimeAsync(3000);

            expect(startSpy).not.toHaveBeenCalled();
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 6: stopViewBotRotation
    // ───────────────────────────────────────────────────────────────────────
    describe('stopViewBotRotation', () => {
        it('stops the current bot, clears currentLiveBot, and clears the rotationTimer', () => {
            const bot = fakeBot('b1', { streaming: true });
            svc.activeBots.set('b1', bot);
            svc.currentLiveBot = 'b1';
            svc.rotationTimer = setTimeout(() => {}, 60000);

            svc.stopViewBotRotation();

            expect(bot.stopStreaming).toHaveBeenCalled();
            expect(svc.currentLiveBot).toBeNull();
            expect(svc.rotationTimer).toBeNull();
        });

        it('is a no-op on currentLiveBot when none is set (no throw)', () => {
            svc.currentLiveBot = null;
            expect(() => svc.stopViewBotRotation()).not.toThrow();
            expect(svc.currentLiveBot).toBeNull();
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 7: forceRotation
    // ───────────────────────────────────────────────────────────────────────
    describe('forceRotation', () => {
        it('returns {success:false, "Rotation is disabled"} when disabled', async () => {
            svc.rotationEnabled = false;
            const result = await svc.forceRotation();
            expect(result).toEqual({ success: false, message: 'Rotation is disabled' });
        });

        it('returns {success:false, "No ViewBot currently streaming"} when no currentLiveBot', async () => {
            svc.rotationEnabled = true;
            svc.currentLiveBot = null;
            const result = await svc.forceRotation();
            expect(result).toEqual({ success: false, message: 'No ViewBot currently streaming' });
        });

        it("queues a 'forced' rotation request for the current live bot and returns the queue result", async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = 'b1';
            const queueSpy = jest.spyOn(svc, 'queueRotationRequest');

            const result = await svc.forceRotation();

            expect(queueSpy).toHaveBeenCalledWith('b1', 'forced');
            expect(result).toEqual({ success: true, message: 'Rotation request queued' });
            expect(svc.rotationRequestQueue.length).toBe(1);
            expect(svc.rotationRequestQueue.items[0]).toMatchObject({ botId: 'b1', reason: 'forced' });
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract: manualTriggerTakeover
    // ───────────────────────────────────────────────────────────────────────
    describe('manualTriggerTakeover', () => {
        it('returns {success:false, "Rotation is disabled"} when disabled', async () => {
            svc.rotationEnabled = false;
            expect(await svc.manualTriggerTakeover()).toEqual({ success: false, message: 'Rotation is disabled' });
        });

        it('returns {success:false, "Real streamer is active"} when a real streamer is active', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = true;
            expect(await svc.manualTriggerTakeover()).toEqual({ success: false, message: 'Real streamer is active' });
        });

        it('returns already-live message when a ViewBot is already live (no startViewBotRotation)', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = 'b1';
            const startSpy = jest.spyOn(svc, 'startViewBotRotation').mockResolvedValue(undefined);

            const result = await svc.manualTriggerTakeover();

            expect(result).toEqual({ success: false, message: 'ViewBot b1 is already live' });
            expect(startSpy).not.toHaveBeenCalled();
        });

        it('calls startViewBotRotation and returns success with currentLiveBot when conditions are clear', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = null;
            const startSpy = jest.spyOn(svc, 'startViewBotRotation').mockImplementation(async () => {
                svc.currentLiveBot = 'b9';
            });

            const result = await svc.manualTriggerTakeover();

            expect(startSpy).toHaveBeenCalled();
            expect(result).toEqual({
                success: true,
                message: 'ViewBot takeover triggered',
                currentLiveBot: 'b9',
            });
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract: scheduleViewBotTakeover
    // ───────────────────────────────────────────────────────────────────────
    describe('scheduleViewBotTakeover', () => {
        it('arms a pendingTakeoverTimer that fires startViewBotRotation when conditions still hold', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = null;
            const startSpy = jest.spyOn(svc, 'startViewBotRotation').mockResolvedValue(undefined);

            svc.scheduleViewBotTakeover();
            expect(svc.pendingTakeoverTimer).not.toBeNull();
            expect(startSpy).not.toHaveBeenCalled();

            // Delay is randomized 5000-10000ms; advance past the max.
            await jest.advanceTimersByTimeAsync(10000);

            expect(startSpy).toHaveBeenCalled();
            expect(svc.pendingTakeoverTimer).toBeNull();
        });

        it('cancels the takeover on fire when a real streamer has become active', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = null;
            const startSpy = jest.spyOn(svc, 'startViewBotRotation').mockResolvedValue(undefined);

            svc.scheduleViewBotTakeover();
            // Conditions change before the timer fires.
            svc.realStreamerActive = true;
            await jest.advanceTimersByTimeAsync(10000);

            expect(startSpy).not.toHaveBeenCalled();
        });

        it('replaces an existing pending timer rather than stacking two', () => {
            svc.scheduleViewBotTakeover();
            const first = svc.pendingTakeoverTimer;
            svc.scheduleViewBotTakeover();
            // A fresh handle was installed (the old one cleared).
            expect(svc.pendingTakeoverTimer).not.toBe(first);
            expect(svc.pendingTakeoverTimer).not.toBeNull();
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract 8: maintainViewBotPresence — gating short-circuits
    // ───────────────────────────────────────────────────────────────────────
    describe('maintainViewBotPresence — gating', () => {
        it('returns without touching state when rotation is disabled', async () => {
            svc.rotationEnabled = false;
            svc.currentLiveBot = null;
            const startBot = jest.spyOn(svc, 'startBotStreaming').mockResolvedValue({ success: true });
            await svc.maintainViewBotPresence();
            expect(startBot).not.toHaveBeenCalled();
        });

        it('returns without starting a bot when a real streamer is active', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = true;
            const startBot = jest.spyOn(svc, 'startBotStreaming').mockResolvedValue({ success: true });
            await svc.maintainViewBotPresence();
            expect(startBot).not.toHaveBeenCalled();
        });

        it('does not start an emergency bot when the rotation lock is held', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = null;
            svc.rotationLock = true;
            const startBot = jest.spyOn(svc, 'startBotStreaming').mockResolvedValue({ success: true });
            await svc.maintainViewBotPresence();
            expect(startBot).not.toHaveBeenCalled();
        });

        it('does not start an emergency bot when there are pending requests in the queue', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = null;
            svc.rotationRequestQueue.enqueue('b1', 'video-end', { rotationEnabled: true, realStreamerActive: false });
            const startBot = jest.spyOn(svc, 'startBotStreaming').mockResolvedValue({ success: true });
            await svc.maintainViewBotPresence();
            expect(startBot).not.toHaveBeenCalled();
        });

        it('starts an emergency bot (and pre-sets currentLiveBot) when no one is streaming and a bot is available', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = null;
            svc.activeBots.set('b1', fakeBot('b1', { streaming: false, isConnected: true }));
            const startBot = jest.spyOn(svc, 'startBotStreaming').mockResolvedValue({ success: true });

            await svc.maintainViewBotPresence();

            expect(startBot).toHaveBeenCalledWith('b1');
            // Pre-set to prevent duplicate emergency starts.
            expect(svc.currentLiveBot).toBe('b1');
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Contract: restartRotationAfterRestore — observable startViewBotRotation
    // ───────────────────────────────────────────────────────────────────────
    describe('restartRotationAfterRestore', () => {
        it('starts a fresh rotation when there is no currentLiveBot to restore', async () => {
            svc.rotationEnabled = true;
            svc.realStreamerActive = false;
            svc.currentLiveBot = null;
            const startSpy = jest.spyOn(svc, 'startViewBotRotation').mockResolvedValue(undefined);

            await svc.restartRotationAfterRestore();

            expect(startSpy).toHaveBeenCalled();
        });
    });
});
