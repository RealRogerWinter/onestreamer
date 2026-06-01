/**
 * ViewBotInstance — post-extraction (PR 11.1 / ADR-0019) constructor + pure-helper
 * contract tests.
 *
 * PR 11.1 split this class out of ViewBotClientService.js (orchestrator
 * 6015 → ~2290 lines; new file ~3700 lines). The split is mechanical
 * (no behavior change, no API change per ADR-0019), but there is no
 * existing targeted coverage for the extracted class's own state shape
 * or for the pure-function arg-builders that survived the split.
 *
 * What this file pins:
 *   1. Constructor produces the expected state shape (the fields the
 *      orchestrator's `updateRotationSettings` filter, ProcessManager,
 *      and downstream state-persistence code read).
 *   2. parentService-derived defaults thread through the constructor
 *      (rotation probability + check-interval bounds inherit from the
 *      orchestrator, with hard-coded fallbacks when no parent is given).
 *   3. createAudioFFmpegArgs is a pure function over (config, audioRtpPort).
 *      The argv it returns is the FFmpeg invocation that determines whether
 *      audio streams correctly to MediaSoup — silently breaking it is the
 *      kind of regression test coverage exists to catch.
 *
 * What this file does NOT test (covered elsewhere or operationally smoke-tested):
 *   - The puppeteer / socket.io browser-tab orchestration in startStreaming()
 *     (requires headful Chromium, lives in maintainer smoke).
 *   - The FFmpeg spawn pipeline itself (real-process integration, gated
 *     on having ffmpeg on PATH).
 *   - The GStreamer pipeline path (requires `gst-launch-1.0` on PATH).
 *   - The MediaSoup transport setup (requires a live SFU).
 */

jest.mock('puppeteer', () => ({
    launch: jest.fn(),
}));

// ProcessManager / state-manager are singletons that emit logs on construction
// — stub them so the test doesn't pollute output and the lifecycle is inert.
jest.mock('../../services/ProcessManager', () => ({
    registerProcess: jest.fn(),
    killBotProcesses: jest.fn(async () => {}),
    reapAll: jest.fn(async () => ({ tracked: 0 })),
}));

jest.mock('../../services/ViewBotStateManager', () => ({
    getViewBotState: jest.fn(() => ({})),
    setViewBotState: jest.fn(),
    clearViewBotState: jest.fn(),
}));

const ViewBotInstance = require('../../services/viewbot/ViewBotInstance');

describe('ViewBotInstance — post-extraction constructor + pure helpers (PR 11.1 / ADR-0019)', () => {
    describe('constructor — state shape', () => {
        it('initializes all documented state fields to their default values when no parentService is given', () => {
            const bot = new ViewBotInstance('bot-A', { contentType: 'testPattern' }, 'https://localhost:8443', null);

            // Identity + caller-supplied refs.
            expect(bot.botId).toBe('bot-A');
            expect(bot.config).toEqual({ contentType: 'testPattern' });
            expect(bot.serverUrl).toBe('https://localhost:8443');
            expect(bot.mediasoupService).toBeNull();
            expect(bot.parentService).toBeNull();

            // Connection state — null/false defaults; the streaming session
            // is what the rest of the system checks (isStreaming / streaming).
            expect(bot.socket).toBeNull();
            expect(bot.browser).toBeNull();
            expect(bot.page).toBeNull();
            expect(bot.mediaStream).toBeNull();
            expect(bot.isConnected).toBe(false);
            expect(bot.streaming).toBe(false);
            expect(bot.startTime).toBeNull();
            expect(bot.lastError).toBeNull();

            // Rotation-system fields — these are what
            // ViewBotClientService.updateRotationSettings (PR 11.2 bug-fix
            // block) reads + filters against.
            expect(bot.rotationCheckTimer).toBeNull();
            expect(bot.nextCheckTime).toBeNull();

            // FFmpeg / RTP transport fields — initially null, populated
            // when the server allocates ports. (videoSSRC/audioSSRC were
            // gst-only and removed with the MediaSoup/GStreamer video-file path.)
            expect(bot.videoFFmpeg).toBeNull();
            expect(bot.audioFFmpeg).toBeNull();
            expect(bot.videoRtpPort).toBeNull();
            expect(bot.audioRtpPort).toBeNull();

            // Database session fields — populated when ViewBotDatabaseService
            // opens a session.
            expect(bot.currentSessionId).toBeNull();
            expect(bot.sessionStartTime).toBeNull();
        });

        it('falls back to hard-coded rotation defaults when parentService is null', () => {
            // The hard-coded defaults are: rotationProbability=0.31,
            // rotationCheckIntervalMin=5000, rotationCheckIntervalMax=10000.
            // These are the same values ViewBotClientService's constructor
            // uses, so a null-parent ViewBotInstance and an orchestrator-with-
            // defaults parent see identical numbers — important so the
            // standalone test/dev scaffolding behaves like production.
            const bot = new ViewBotInstance('bot-B', {}, 'https://x', null, null);
            expect(bot.rotationProbability).toBeCloseTo(0.31);
            expect(bot.checkIntervalMin).toBe(5000);
            expect(bot.checkIntervalMax).toBe(10000);
        });

        it('inherits rotation settings from a parentService when one is supplied', () => {
            const parent = {
                rotationProbability: 0.75,
                rotationCheckIntervalMin: 1500,
                rotationCheckIntervalMax: 3000,
            };
            const bot = new ViewBotInstance('bot-C', {}, 'https://x', null, parent);
            expect(bot.rotationProbability).toBe(0.75);
            expect(bot.checkIntervalMin).toBe(1500);
            expect(bot.checkIntervalMax).toBe(3000);
            expect(bot.parentService).toBe(parent);
        });
    });

    describe('createAudioFFmpegArgs — pure-function regression gate', () => {
        function makeBot({ audioRtpPort = 50000, contentType = 'testPattern', videoFile = null } = {}) {
            const bot = new ViewBotInstance('bot-X', { contentType, videoFile }, 'https://x', null, null);
            bot.audioRtpPort = audioRtpPort;
            return bot;
        }

        it('throws when audioRtpPort has not been allocated', () => {
            const bot = makeBot({ audioRtpPort: null });
            expect(() => bot.createAudioFFmpegArgs()).toThrow(/Audio RTP port/);
        });

        it('builds a silent-anullsrc input when contentType is not videoFile', () => {
            const bot = makeBot({ audioRtpPort: 50002 });
            const args = bot.createAudioFFmpegArgs();

            // Spot-check the load-bearing flags. If any of these change,
            // production audio breaks.
            expect(args).toContain('-re');
            expect(args).toContain('-f');
            expect(args).toContain('lavfi');
            expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=48000:duration=3600');
            expect(args).toContain('libopus');
            expect(args).toContain('-b:a');
            expect(args).toContain('128k');
            expect(args).toContain('-ar');
            expect(args).toContain('48000');
            expect(args).toContain('-ac');
            expect(args).toContain('2');
            expect(args).toContain('-application');
            expect(args).toContain('voip');
            expect(args).toContain('-payload_type');
            expect(args).toContain('111');

            // Fixed audio SSRC pinned at 22222222 — must match MediaSoup
            // expectation in the matching audio producer setup.
            expect(args).toContain('-ssrc');
            expect(args).toContain('22222222');

            // Final arg is the rtp:// URL containing the allocated port.
            const last = args[args.length - 1];
            expect(last).toMatch(/^rtp:\/\/[^:]+:50002$/);
        });

        it('embeds the allocated audioRtpPort into the rtp:// URL', () => {
            const bot1 = makeBot({ audioRtpPort: 51111 });
            const bot2 = makeBot({ audioRtpPort: 52222 });
            const url1 = bot1.createAudioFFmpegArgs().at(-1);
            const url2 = bot2.createAudioFFmpegArgs().at(-1);
            expect(url1).toMatch(/:51111$/);
            expect(url2).toMatch(/:52222$/);
        });

        it('honours SERVER_HOST env var for the rtp:// destination, falling back to 127.0.0.1', () => {
            const saved = process.env.SERVER_HOST;
            try {
                delete process.env.SERVER_HOST;
                const bot = makeBot({ audioRtpPort: 53333 });
                const last = bot.createAudioFFmpegArgs().at(-1);
                expect(last).toBe('rtp://127.0.0.1:53333');

                process.env.SERVER_HOST = 'media.example.com';
                const bot2 = makeBot({ audioRtpPort: 53334 });
                const last2 = bot2.createAudioFFmpegArgs().at(-1);
                expect(last2).toBe('rtp://media.example.com:53334');
            } finally {
                if (saved === undefined) delete process.env.SERVER_HOST;
                else process.env.SERVER_HOST = saved;
            }
        });
    });

    describe('createVideoFFmpegArgs — pure-function regression gate', () => {
        function makeBot({ videoRtpPort = 50000, contentType = 'testPattern', videoFile = null } = {}) {
            const bot = new ViewBotInstance('bot-V', { contentType, videoFile }, 'https://x', null, null);
            bot.videoRtpPort = videoRtpPort;
            return bot;
        }

        it('throws when videoRtpPort has not been allocated', () => {
            const bot = makeBot({ videoRtpPort: null });
            expect(() => bot.createVideoFFmpegArgs(1280, 720, 30, 'testsrc')).toThrow(/Video RTP port/);
        });

        it('throws when contentType=videoFile and the file does not exist on disk', () => {
            const bot = makeBot({
                videoRtpPort: 60000,
                contentType: 'videoFile',
                videoFile: '/nonexistent/path/never-real.mp4',
            });
            expect(() => bot.createVideoFFmpegArgs(1280, 720, 30, 'testsrc'))
                .toThrow(/Video file not found/);
        });
    });
});
