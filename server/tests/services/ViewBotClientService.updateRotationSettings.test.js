/**
 * ViewBotClientService.updateRotationSettings + getRotationSettings —
 * post-extraction regression gate for the PR 11.2 bug-fix block.
 *
 * Background: PR 11.1 (ADR-0019) split ViewBotInstance out of
 * ViewBotClientService.js. PR 11.2 closed three coupled latent bugs in
 * `updateRotationSettings`, all in the same 12-line block (orchestrator
 * lines ~188–212 on main):
 *
 *   1. `this.viewBots` → `this.activeBots` (the field is `activeBots`,
 *      `viewBots` was always undefined and the block always TypeError'd).
 *   2. `this.startRotationCheckTimer(bot.botId)` → `bot.startRotationCheckTimer()`
 *      (the method lives on ViewBotInstance, not the orchestrator, and
 *      takes no args).
 *   3. `.filter(bot => bot.isStreaming)` → invoking-or-property variant
 *      (function-reference is always truthy, filter was a no-op).
 *
 * The full-suite-green at PR 11.2 close was the verification. This file
 * pins each contract so a future "tidy" can't re-introduce any of them.
 *
 * Construction strategy: ViewBotClientService's constructor fires
 * `initialize()` (DB + state restore), schedules a 10s `setTimeout`, and
 * sets a 30-min `setInterval` cooldown cleanup. We mock the heavy
 * sub-service (`ViewBotDatabaseService`),
 * stub `fs.writeFileSync` / `fs.readFileSync` for the rotation config,
 * and run under fake timers so the long-lived intervals don't leak past
 * the test.
 */

jest.mock('../../services/ViewBotDatabaseService', () => {
    return class ViewBotDatabaseServiceStub {
        constructor() { this.initialized = false; }
        async initialize() { this.initialized = true; }
        async getAllBots() { return []; }
        async getSystemState() { return {}; }
        async saveSystemState() {}
    };
});

jest.mock('../../services/ProcessManager', () => ({
    killBotProcesses: jest.fn(async () => {}),
    killAllGStreamerProcesses: jest.fn(async () => {}),
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
// corrupt the real `viewbot-rotation-config.json` next to the server.
const fs = require('fs');
const path = require('path');
let configPathCaptured = null;
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
            configPathCaptured = p;
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

// Stub the spawn-backed FFmpeg detector before any constructor runs. The
// real detector spawns real `ffmpeg -version`; under fake timers the 3-second
// kill setTimeout never fires, so the spawned child kept the process alive
// and Jest hung waiting for handles. The static method always reports
// "available" via the stub.
ViewBotClientService.checkFFmpegAvailability = jest.fn(async () => ({
    available: true,
    path: '/usr/bin/ffmpeg',
}));

describe('ViewBotClientService.updateRotationSettings + getRotationSettings (PR 11.2 regression gate)', () => {
    let svc;

    beforeEach(() => {
        configContents = null;
        configPathCaptured = null;
        jest.useFakeTimers();
        // Construct with all dependencies null — the methods under test
        // (updateRotationSettings, getRotationSettings, getBotIdBySocketId)
        // don't reach into any of them. The async initialize() that the
        // constructor fires will fail somewhere downstream and be swallowed
        // by the constructor's catch — that's fine for these unit tests.
        svc = new ViewBotClientService(null, null, null, null);
    });

    afterEach(() => {
        // The constructor schedules two long-lived timers without storing
        // their handles (`startCooldownCleanup` at ~30 min, `startAutoValidation`
        // at the validation cadence). Without these the test suite leaks
        // open handles and requires `--forceExit`. Clear all fake timers
        // explicitly before flipping back to real timers.
        if (svc && typeof svc.stopAutoValidation === 'function') {
            try { svc.stopAutoValidation(); } catch (_) {}
        }
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    describe('getRotationSettings', () => {
        it('returns the three rotation fields with constructor defaults', () => {
            const settings = svc.getRotationSettings();
            expect(settings).toEqual({
                rotationProbability: 0.31,
                rotationCheckIntervalMin: 5000,
                rotationCheckIntervalMax: 10000,
            });
        });
    });

    describe('updateRotationSettings — field propagation', () => {
        it('updates all three fields when all are supplied', () => {
            svc.updateRotationSettings({
                rotationProbability: 0.5,
                rotationCheckIntervalMin: 2000,
                rotationCheckIntervalMax: 4000,
            });
            expect(svc.getRotationSettings()).toEqual({
                rotationProbability: 0.5,
                rotationCheckIntervalMin: 2000,
                rotationCheckIntervalMax: 4000,
            });
        });

        it('only updates supplied fields; omitted fields keep their previous value', () => {
            svc.updateRotationSettings({ rotationProbability: 0.75 });
            const after = svc.getRotationSettings();
            expect(after.rotationProbability).toBe(0.75);
            expect(after.rotationCheckIntervalMin).toBe(5000);
            expect(after.rotationCheckIntervalMax).toBe(10000);
        });

        it('persists settings via saveRotationConfig (writes to the rotation-config.json path)', () => {
            svc.updateRotationSettings({
                rotationProbability: 0.42,
                rotationCheckIntervalMin: 3000,
                rotationCheckIntervalMax: 6000,
            });

            expect(configPathCaptured).toMatch(/viewbot-rotation-config\.json$/);
            const written = JSON.parse(configContents);
            expect(written).toMatchObject({
                rotationProbability: 0.42,
                rotationCheckIntervalMin: 3000,
                rotationCheckIntervalMax: 6000,
            });
        });
    });

    describe('updateRotationSettings — PR 11.2 bug-fix block', () => {
        it('does not throw when activeBots is empty (no TypeError on the post-PR-11.2 path)', () => {
            svc.activeBots.clear();
            expect(() => svc.updateRotationSettings({ rotationProbability: 0.5 })).not.toThrow();
        });

        it('restarts the rotation timer for streaming ViewBotInstance objects (isStreaming() method form)', () => {
            // ViewBotInstance shape: has isStreaming() method, rotationCheckTimer
            // holds a setTimeout handle, and startRotationCheckTimer() restarts.
            const startRotationCheckTimer = jest.fn();
            const fakeTimerHandle = setTimeout(() => {}, 60000);
            const botStreaming = {
                botId: 'bot-A',
                isStreaming: jest.fn(() => true),
                streaming: true,
                rotationCheckTimer: fakeTimerHandle,
                startRotationCheckTimer,
            };
            const botNotStreaming = {
                botId: 'bot-B',
                isStreaming: jest.fn(() => false),
                streaming: false,
                rotationCheckTimer: null,
                startRotationCheckTimer: jest.fn(),
            };
            svc.activeBots.set('bot-A', botStreaming);
            svc.activeBots.set('bot-B', botNotStreaming);

            svc.updateRotationSettings({ rotationCheckIntervalMin: 2000 });

            // Only the streaming bot's timer restarted; the non-streaming one
            // (filter rejected) is left alone. This pins fix #3 (the filter
            // actually evaluates isStreaming) AND fix #2 (the restart calls
            // the bot's own method with no args, not an orchestrator method).
            expect(startRotationCheckTimer).toHaveBeenCalledTimes(1);
            expect(startRotationCheckTimer).toHaveBeenCalledWith(); // no args
            expect(botNotStreaming.startRotationCheckTimer).not.toHaveBeenCalled();
            expect(botStreaming.isStreaming).toHaveBeenCalled();
        });

        it('tolerates placeholder objects with no isStreaming() method (restoreViewBots shape)', () => {
            // restoreViewBots places placeholder objects in activeBots while
            // bots are reconnecting. They expose `.streaming` (property, not
            // method); the filter falls back to that. Pins fix #3 + the
            // typeof-function defensive check.
            const startRotationCheckTimer = jest.fn();
            const placeholderStreaming = {
                botId: 'bot-C',
                // no isStreaming method
                streaming: true,
                rotationCheckTimer: setTimeout(() => {}, 60000),
                startRotationCheckTimer,
            };
            const placeholderNotStreaming = {
                botId: 'bot-D',
                streaming: false,
                rotationCheckTimer: null,
                startRotationCheckTimer: jest.fn(),
            };
            svc.activeBots.set('bot-C', placeholderStreaming);
            svc.activeBots.set('bot-D', placeholderNotStreaming);

            expect(() => svc.updateRotationSettings({ rotationCheckIntervalMax: 8000 })).not.toThrow();
            expect(startRotationCheckTimer).toHaveBeenCalledTimes(1);
            expect(placeholderNotStreaming.startRotationCheckTimer).not.toHaveBeenCalled();
        });

        it('does NOT restart a streaming bot whose rotationCheckTimer is null (no orphan call)', () => {
            // A streaming bot that hasn't scheduled its check yet should not
            // get its (non-existent) timer cleared and restarted. The guard
            // is `if (bot.rotationCheckTimer)` — pins that subtle path.
            const startRotationCheckTimer = jest.fn();
            const bot = {
                botId: 'bot-E',
                isStreaming: jest.fn(() => true),
                rotationCheckTimer: null,
                startRotationCheckTimer,
            };
            svc.activeBots.set('bot-E', bot);

            svc.updateRotationSettings({ rotationProbability: 0.9 });

            expect(startRotationCheckTimer).not.toHaveBeenCalled();
        });
    });

    describe('getBotIdBySocketId', () => {
        it('returns the botId of the bot whose socket.id matches', () => {
            svc.activeBots.set('bot-1', { socket: { id: 'socket-aaa' } });
            svc.activeBots.set('bot-2', { socket: { id: 'socket-bbb' } });

            expect(svc.getBotIdBySocketId('socket-bbb')).toBe('bot-2');
            expect(svc.getBotIdBySocketId('socket-aaa')).toBe('bot-1');
        });

        it('returns null when no bot has a matching socket', () => {
            svc.activeBots.set('bot-1', { socket: { id: 'socket-aaa' } });
            expect(svc.getBotIdBySocketId('socket-zzz')).toBeNull();
        });

        it('returns null when activeBots is empty', () => {
            svc.activeBots.clear();
            expect(svc.getBotIdBySocketId('any')).toBeNull();
        });

        it('tolerates bots with no socket (e.g., placeholders before connect)', () => {
            svc.activeBots.set('bot-1', { socket: null });
            svc.activeBots.set('bot-2', { socket: { id: 'socket-aaa' } });
            expect(svc.getBotIdBySocketId('socket-aaa')).toBe('bot-2');
        });
    });
});
