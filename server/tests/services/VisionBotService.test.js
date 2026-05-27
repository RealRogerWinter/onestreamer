// Tests for VisionBotService — the cycle runner, bus subscription, dedup,
// kill-switch / no-egress / url-relay short-circuits, max-bots cap, and
// stop() cleanup. Dependencies are mocked at the module boundary so this
// suite doesn't need ffmpeg, a database, or a working LLM.

jest.mock('../../database/database', () => ({
    runAsync: jest.fn(),
    getAsync: jest.fn(),
    allAsync: jest.fn(),
    db: null,
}));

jest.mock('ollama', () => ({ Ollama: class { constructor() {} } }));

const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

const BotEventBus = require('../../services/BotEventBus');
const TranscriptionDrivenBotService = require('../../services/TranscriptionDrivenBotService');
const VisionBotService = require('../../services/VisionBotService');

function makeDeps(overrides = {}) {
    const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visionbot-test-'));
    // Stub the path resolution so logs go to tmp, not the repo's logs/.
    // Easiest way: monkeypatch the service's logDir after construction.
    const transcriptionService = new EventEmitter();
    transcriptionService.startTimedTranscription = jest.fn(async () => ({ success: true, sessionId: 'mock-session' }));
    transcriptionService.stopTranscription = jest.fn(async () => {});
    transcriptionService.getTranscription = jest.fn(async () => ({ full_text: 'mock transcript' }));

    const chatBotService = {
        generateVisionCommentForBot: jest.fn(async () => ({ success: true, message: 'nice frame' })),
        llmService: {},
        getGlobalPrompt: jest.fn(() => 'global'),
    };

    const continuousRecordingService = { isRecording: true, currentSessionId: 'sess', outputDir: '/tmp', segmentDuration: 4 };
    const streamService = { streamGeneration: 1, getCurrentStreamType: jest.fn(() => 'live') };
    const frameCaptureService = {
        captureFrame: jest.fn(async () => ({
            streamerId: 'streamer-1',
            streamGeneration: 1,
            jpegBase64: 'AAA',
            capturedAt: Date.now(),
            sourceSegment: 'seg_1.ts',
            sizeBytes: 1024,
        })),
        setRetentionHours: jest.fn(),
    };

    return {
        tmpLogDir,
        transcriptionService,
        chatBotService,
        chatService: {},
        database: { db: null },
        botEventBus: new BotEventBus(),
        frameCaptureService,
        streamService,
        continuousRecordingService,
        ...overrides,
    };
}

function makeBot(deps) {
    const bot = new VisionBotService({
        transcriptionService: deps.transcriptionService,
        chatBotService: deps.chatBotService,
        chatService: deps.chatService,
        database: deps.database,
        botEventBus: deps.botEventBus,
        frameCaptureService: deps.frameCaptureService,
        streamService: deps.streamService,
        continuousRecordingService: deps.continuousRecordingService,
    });
    bot.logDir = deps.tmpLogDir;
    bot.ensureLogDirectory();
    bot.config = bot.getDefaultConfig();
    bot.currentStreamerId = 'streamer-1';
    bot.isActive = true;
    bot._getEnabledBots = jest.fn(async () => [
        { id: 1, username: 'bot1', name: 'bot1' },
        { id: 2, username: 'bot2', name: 'bot2' },
        { id: 3, username: 'bot3', name: 'bot3' },
        { id: 4, username: 'bot4', name: 'bot4' },
        { id: 5, username: 'bot5', name: 'bot5' },
    ]);
    return bot;
}

describe('VisionBotService', () => {
    let bot;
    let deps;
    let originalKillSwitch;

    beforeEach(() => {
        jest.useFakeTimers();
        originalKillSwitch = process.env.VISIONBOT_KILL_SWITCH;
        delete process.env.VISIONBOT_KILL_SWITCH;
        deps = makeDeps();
        bot = makeBot(deps);
    });

    afterEach(async () => {
        if (originalKillSwitch !== undefined) {
            process.env.VISIONBOT_KILL_SWITCH = originalKillSwitch;
        } else {
            delete process.env.VISIONBOT_KILL_SWITCH;
        }
        if (bot) await bot.stop();
        jest.useRealTimers();
    });

    test('extends TranscriptionDrivenBotService', () => {
        expect(bot instanceof TranscriptionDrivenBotService).toBe(true);
    });

    test('subscribes to BotEventBus moviebot-transcription-complete on construction', () => {
        expect(deps.botEventBus.listenerCount('moviebot-transcription-complete')).toBe(1);
    });

    test('bus event triggers a cycle that captures a frame and schedules dispatches', async () => {
        bot.config.max_bots_per_cycle = 3;
        // Drive _runCycle directly so we don't have to chase the bus → handler
        // → multiple awaits → setTimeout chain through fake timers.
        await bot._runCycle('something they spoke', new Date(), 'sess-A');
        expect(deps.frameCaptureService.captureFrame).toHaveBeenCalledTimes(1);
        // 3 dispatches scheduled (max cap). Each scheduled via setTimeout —
        // fire them all.
        jest.runAllTimers();
        // Two microtask flushes is enough — _dispatchForBot's mock awaits
        // generateVisionCommentForBot which resolves immediately.
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.chatBotService.generateVisionCommentForBot).toHaveBeenCalledTimes(3);
    });

    test('dedupes by sessionId — the same session does not fire twice', async () => {
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-dup',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-dup',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.frameCaptureService.captureFrame).toHaveBeenCalledTimes(1);
        expect(bot.stats.cycles_dropped.duplicate_session).toBe(1);
    });

    test('ignores bus events for other streamers', async () => {
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'someone-else',
            sessionId: 'sess-B',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.frameCaptureService.captureFrame).not.toHaveBeenCalled();
    });

    test('VISIONBOT_KILL_SWITCH=1 skips the cycle without spawning anything', async () => {
        process.env.VISIONBOT_KILL_SWITCH = '1';
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-K',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.frameCaptureService.captureFrame).not.toHaveBeenCalled();
        expect(bot.stats.cycles_dropped.kill_switch).toBe(1);
    });

    test('skips when continuousRecordingService.isRecording is false', async () => {
        deps.continuousRecordingService.isRecording = false;
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-N',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.frameCaptureService.captureFrame).not.toHaveBeenCalled();
        expect(bot.stats.cycles_dropped.no_egress).toBe(1);
    });

    test('refuses URL-relay streams unless allow_url_relay is on', async () => {
        deps.streamService.getCurrentStreamType = jest.fn(() => 'url-relay');
        bot.config.allow_url_relay = false;
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-U',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.frameCaptureService.captureFrame).not.toHaveBeenCalled();
        expect(bot.stats.cycles_dropped.url_relay_disallowed).toBe(1);
    });

    test('allows URL-relay streams when allow_url_relay is on', async () => {
        deps.streamService.getCurrentStreamType = jest.fn(() => 'url-relay');
        bot.config.allow_url_relay = true;
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-U2',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.frameCaptureService.captureFrame).toHaveBeenCalled();
    });

    test('skips dispatch when frame capture returns null', async () => {
        deps.frameCaptureService.captureFrame = jest.fn(async () => null);
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-NF',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        jest.runAllTimers();
        await Promise.resolve();
        expect(deps.chatBotService.generateVisionCommentForBot).not.toHaveBeenCalled();
        expect(bot.stats.cycles_dropped.no_frame).toBe(1);
    });

    test('skips when no chatbots have vision_bot_enabled=1', async () => {
        bot._getEnabledBots = jest.fn(async () => []);
        deps.botEventBus.emit('moviebot-transcription-complete', {
            streamerId: 'streamer-1',
            sessionId: 'sess-NB',
            transcription: 'x',
            endTime: new Date(),
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(bot.stats.cycles_dropped.no_bots).toBe(1);
    });

    test('caps fan-out at max_bots_per_cycle', async () => {
        bot.config.max_bots_per_cycle = 2;
        await bot._runCycle('x', new Date(), 'sess-cap');
        jest.runAllTimers();
        await Promise.resolve();
        await Promise.resolve();
        expect(deps.chatBotService.generateVisionCommentForBot).toHaveBeenCalledTimes(2);
    });

    // OmniImageMod PR 3 (ADR-0021)
    describe('image-moderation gate', () => {
        test('halts cycle on auto_ban — no bot dispatch fires', async () => {
            const handleVisionFrame = jest.fn(async () => ({
                final_decision: 'auto_ban',
                action_taken: 'banned:42;rotation=ok',
            }));
            bot.setModerationService({ handleVisionFrame });
            await bot._runCycle('x', new Date(), 'sess-mod-banned');
            jest.runAllTimers();
            await Promise.resolve();
            expect(handleVisionFrame).toHaveBeenCalledTimes(1);
            expect(deps.chatBotService.generateVisionCommentForBot).not.toHaveBeenCalled();
            expect(bot.stats.cycles_dropped.moderated).toBe(1);
        });

        test('halts cycle on auto_skip (url-relay block)', async () => {
            const handleVisionFrame = jest.fn(async () => ({
                final_decision: 'auto_skip',
                action_taken: 'blocked:twitch:foo',
            }));
            bot.setModerationService({ handleVisionFrame });
            await bot._runCycle('x', new Date(), 'sess-mod-skip');
            jest.runAllTimers();
            await Promise.resolve();
            expect(deps.chatBotService.generateVisionCommentForBot).not.toHaveBeenCalled();
            expect(bot.stats.cycles_dropped.moderated).toBe(1);
        });

        test('continues to dispatch on clean (null result)', async () => {
            const handleVisionFrame = jest.fn(async () => null);
            bot.setModerationService({ handleVisionFrame });
            bot.config.max_bots_per_cycle = 1;
            await bot._runCycle('x', new Date(), 'sess-mod-clean');
            jest.runAllTimers();
            await Promise.resolve();
            await Promise.resolve();
            expect(handleVisionFrame).toHaveBeenCalledTimes(1);
            expect(deps.chatBotService.generateVisionCommentForBot).toHaveBeenCalledTimes(1);
        });

        test('continues to dispatch on admin_review (enforce=off path)', async () => {
            const handleVisionFrame = jest.fn(async () => ({
                final_decision: 'admin_review',
                action_taken: null,
            }));
            bot.setModerationService({ handleVisionFrame });
            bot.config.max_bots_per_cycle = 1;
            await bot._runCycle('x', new Date(), 'sess-mod-review');
            jest.runAllTimers();
            await Promise.resolve();
            await Promise.resolve();
            expect(deps.chatBotService.generateVisionCommentForBot).toHaveBeenCalledTimes(1);
        });

        test('fail-open: gate that throws does NOT silence the bot', async () => {
            const handleVisionFrame = jest.fn(async () => { throw new Error('moderation crashed'); });
            bot.setModerationService({ handleVisionFrame });
            bot.config.max_bots_per_cycle = 1;
            await bot._runCycle('x', new Date(), 'sess-mod-throw');
            jest.runAllTimers();
            await Promise.resolve();
            await Promise.resolve();
            expect(deps.chatBotService.generateVisionCommentForBot).toHaveBeenCalledTimes(1);
        });

        test('passes streamerId, sessionId, endTime, transcription into the gate', async () => {
            const handleVisionFrame = jest.fn(async () => null);
            bot.setModerationService({ handleVisionFrame });
            const endTime = new Date();
            await bot._runCycle('spoken', endTime, 'sess-args');
            expect(handleVisionFrame).toHaveBeenCalledWith(expect.objectContaining({
                streamerId: 'streamer-1',
                sessionId: 'sess-args',
                endTime,
                transcription: 'spoken',
            }));
        });

        test('skipped when moderationService is not wired (no setter call)', async () => {
            // Default fixture has no moderationService — gate is a no-op.
            bot.config.max_bots_per_cycle = 1;
            await bot._runCycle('x', new Date(), 'sess-no-mod');
            jest.runAllTimers();
            await Promise.resolve();
            await Promise.resolve();
            expect(deps.chatBotService.generateVisionCommentForBot).toHaveBeenCalledTimes(1);
        });
    });

    test('records groq 429 in cycles_dropped and bumps consecutive_failures', async () => {
        const e = new Error('rate limit');
        e.name = 'GroqRateLimitError';
        e.retryAfterSeconds = 30;
        deps.chatBotService.generateVisionCommentForBot = jest.fn(async () => { throw e; });
        bot.config.max_bots_per_cycle = 1;
        // Call _dispatchForBot directly so the recording happens synchronously
        // through one rejected promise — no setTimeout dance.
        await bot._dispatchForBot(
            { id: 1, username: 'bot1' },
            { streamerId: 'streamer-1', streamGeneration: 1, jpegBase64: 'AAA', sourceSegment: 'seg.ts', sizeBytes: 1 },
            'x',
            [],
            (new AbortController()).signal,
        );
        expect(bot.stats.cycles_dropped.groq_429).toBeGreaterThan(0);
        expect(bot.config.consecutive_failures).toBeGreaterThan(0);
        expect(bot.config.last_groq_429_at).toBeTruthy();
    });

    test('stop() unsubscribes from the bus and aborts the in-flight controller', async () => {
        bot.activeController = new AbortController();
        const signal = bot.activeController.signal;
        await bot.stop();
        expect(deps.botEventBus.listenerCount('moviebot-transcription-complete')).toBe(0);
        expect(signal.aborted).toBe(true);
        bot = null; // tell afterEach not to re-stop
    });

    test('getStatus reports counters, config, and kill-switch env state', () => {
        bot.stats.cycles_attempted = 5;
        bot.stats.cycles_succeeded = 3;
        bot.stats.cycles_dropped.no_frame = 2;
        const s = bot.getStatus();
        expect(s.cycles_attempted).toBe(5);
        expect(s.cycles_succeeded).toBe(3);
        expect(s.cycles_dropped.no_frame).toBe(2);
        expect(s.kill_switch_env).toBe(false);
        expect(s.config).toBeTruthy();
    });

    test('updateConfig clamps unsafe values (frequency floor 60s, max_bots cap 5, retention 24h)', () => {
        bot.updateConfig({
            transcription_frequency_s: 1, // too low
            max_bots_per_cycle: 99,
            frame_retention_hours: 1000,
            image_resolution_px: 5,
        });
        expect(bot.config.transcription_frequency_s).toBe(60);
        expect(bot.config.max_bots_per_cycle).toBe(5);
        expect(bot.config.frame_retention_hours).toBe(24);
        expect(bot.config.image_resolution_px).toBe(128);
    });
});
