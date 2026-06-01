// Tests for the TranscriptionDrivenBotService base class extracted from
// MovieBotService. Verifies the hooks contract, shared chat-listener wiring,
// the meaningful-transcription validator, and that MovieBotService correctly
// subclasses the base.

const path = require('path');
const fs = require('fs');
const os = require('os');
const EventEmitter = require('events');

const TranscriptionDrivenBotService = require('../../services/TranscriptionDrivenBotService');
const MovieBotService = require('../../services/MovieBotService');
const BotEventBus = require('../../services/BotEventBus');

function makeStubDeps(overrides = {}) {
    const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdbs-test-'));
    const transcriptionService = new EventEmitter();
    transcriptionService.startTimedTranscription = jest.fn(async () => ({ success: true, sessionId: 'sess-1' }));
    transcriptionService.stopTranscription = jest.fn(async () => {});
    transcriptionService.getTranscription = jest.fn(async () => ({ full_text: 'hello world from db' }));
    return {
        logDir: tmpLogDir,
        transcriptionService,
        chatBotService: { llmService: {} },
        chatService: {},
        database: { db: null },
        botEventBus: new BotEventBus(),
        ...overrides,
    };
}

// Minimal concrete subclass exercising only the contract, not any real bot.
class StubBot extends TranscriptionDrivenBotService {
    constructor(deps) {
        super({
            botName: 'StubBot',
            eventPrefix: 'stubbot',
            configTableName: 'stub_config',
            ...deps,
        });
        this.dispatched = [];
        this.config = this.getDefaultConfig();
    }
    getDefaultConfig() {
        return {
            enabled: false,
            transcriptionDuration: 1,
            transcriptionFrequency: 60,
            chatHistoryLimit: 30,
        };
    }
    parseConfigRow(row) {
        return { enabled: row.enabled === 1, transcriptionDuration: 1, transcriptionFrequency: 60, chatHistoryLimit: 30 };
    }
    buildSaveConfigSQL() { return { query: 'SELECT 1', params: [] }; }
    async onTranscriptionComplete(text, sessionData) {
        this.dispatched.push({ text, sessionData });
    }
}

describe('TranscriptionDrivenBotService', () => {
    describe('subclass contract', () => {
        test('base hooks throw with the subclass name when not overridden', () => {
            class Incomplete extends TranscriptionDrivenBotService {}
            const deps = makeStubDeps();
            const inst = new Incomplete({
                botName: 'Incomplete',
                eventPrefix: 'inc',
                configTableName: 'inc',
                ...deps,
            });
            expect(() => inst.getDefaultConfig()).toThrow(/Incomplete/);
            expect(() => inst.parseConfigRow({})).toThrow(/Incomplete/);
            expect(() => inst.buildSaveConfigSQL(false, null)).toThrow(/Incomplete/);
            expect(inst.onTranscriptionComplete('x', {})).rejects.toThrow(/Incomplete/);
        });

        test('afterConfigLoaded is a no-op by default', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            expect(() => bot.afterConfigLoaded({})).not.toThrow();
        });
    });

    describe('chat listener wiring', () => {
        test('subscribes to BotEventBus chat-message and accumulates messages', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            deps.botEventBus.emit('chat-message', { username: 'alice', message: 'hi' });
            deps.botEventBus.emit('chat-message', { username: 'bob', message: 'hello' });
            expect(bot.recentChatMessages).toHaveLength(2);
            expect(bot.recentChatMessages[0].username).toBe('alice');
        });

        test('filters bot-prefixed usernames (emoji marker)', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            deps.botEventBus.emit('chat-message', { username: '🤖TheBot', message: 'hi' });
            deps.botEventBus.emit('chat-message', { username: 'alice', message: 'hi' });
            expect(bot.recentChatMessages).toHaveLength(1);
            expect(bot.recentChatMessages[0].username).toBe('alice');
        });

        test('caps history at MAX_CHAT_HISTORY', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            bot.MAX_CHAT_HISTORY = 3;
            for (let i = 0; i < 5; i++) {
                bot.addChatMessage(`user${i}`, `msg${i}`);
            }
            expect(bot.recentChatMessages).toHaveLength(3);
            expect(bot.recentChatMessages[0].username).toBe('user2');
        });
    });

    describe('validateMeaningfulTranscription', () => {
        test('rejects empty or non-string input', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            expect(bot.validateMeaningfulTranscription(null)).toBeNull();
            expect(bot.validateMeaningfulTranscription('')).toBeNull();
            expect(bot.validateMeaningfulTranscription(42)).toBeNull();
        });

        test('rejects strings shorter than 10 chars', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            expect(bot.validateMeaningfulTranscription('short')).toBeNull();
        });

        test('rejects stopword-only Whisper hallucinations', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            expect(bot.validateMeaningfulTranscription('you you you the the and')).toBeNull();
        });

        test('accepts a transcription with enough meaningful words', () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            const r = bot.validateMeaningfulTranscription('lights camera action streaming live now');
            expect(r).not.toBeNull();
            expect(r.cleanText).toBe('lights camera action streaming live now');
            expect(r.meaningfulWords.length).toBeGreaterThanOrEqual(3);
        });
    });

    describe('transcription scheduler', () => {
        test('captureAndProcessTranscription fires onTranscriptionComplete with the session data', async () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            bot.isActive = true;
            bot.currentStreamerId = 'streamer-1';
            const completed = new Promise(resolve => {
                bot.onTranscriptionComplete = async (text, data) => {
                    bot.dispatched.push({ text, data });
                    resolve();
                };
            });
            // Reschedule timer is harmless in test; we just need the handler to fire.
            await bot.captureAndProcessTranscription();
            // Emit the stopped event with the session ID returned by the stub.
            deps.transcriptionService.emit('transcription-stopped', {
                sessionId: 'sess-1',
                transcription: 'a small spoken sentence about the stream',
                endTime: new Date(),
                wordCount: 8,
            });
            await completed;
            expect(bot.dispatched).toHaveLength(1);
            expect(bot.dispatched[0].text).toBe('a small spoken sentence about the stream');
            // Cleanup the timer so jest can exit cleanly.
            if (bot.transcriptionTimer) clearTimeout(bot.transcriptionTimer);
        });

        test('falls back to fetching transcription from DB when event payload omits it', async () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            bot.isActive = true;
            bot.currentStreamerId = 'streamer-1';
            const completed = new Promise(resolve => {
                bot.onTranscriptionComplete = async (text) => {
                    bot.dispatched.push(text);
                    resolve();
                };
            });
            await bot.captureAndProcessTranscription();
            deps.transcriptionService.emit('transcription-stopped', {
                sessionId: 'sess-1',
                endTime: new Date(),
                wordCount: 4,
            });
            await completed;
            expect(bot.dispatched).toEqual(['hello world from db']);
            if (bot.transcriptionTimer) clearTimeout(bot.transcriptionTimer);
        });

        test('ignores transcription-stopped events for other sessions', async () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            bot.isActive = true;
            bot.currentStreamerId = 'streamer-1';
            await bot.captureAndProcessTranscription();
            deps.transcriptionService.emit('transcription-stopped', {
                sessionId: 'OTHER-session',
                transcription: 'not for us',
                endTime: new Date(),
            });
            // Give a microtask tick for the listener to evaluate the filter.
            await new Promise(r => setImmediate(r));
            expect(bot.dispatched).toHaveLength(0);
            if (bot.transcriptionTimer) clearTimeout(bot.transcriptionTimer);
        });
    });

    describe('stop()', () => {
        test('removes the bus chat-message listener', async () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            expect(deps.botEventBus.listenerCount('chat-message')).toBe(1);
            await bot.stop();
            expect(deps.botEventBus.listenerCount('chat-message')).toBe(0);
        });

        test('clears a pending transcription timer', async () => {
            const deps = makeStubDeps();
            const bot = new StubBot(deps);
            bot.isActive = true;
            bot.config.transcriptionFrequency = 999;
            bot.scheduleNextTranscription();
            expect(bot.transcriptionTimer).not.toBeNull();
            await bot.stop();
            expect(bot.transcriptionTimer).toBeNull();
        });
    });
});

describe('MovieBotService inheritance', () => {
    test('extends TranscriptionDrivenBotService', () => {
        expect(MovieBotService.prototype instanceof TranscriptionDrivenBotService).toBe(true);
    });

    test('exposes movie-specific dispatch and prompting on the prototype', () => {
        // Inspect the prototype directly to avoid instantiating MovieBotService
        // here — its constructor schedules a deferred loadConfigFromDatabase
        // via setTimeout that would leak into the next test.
        expect(typeof MovieBotService.prototype.processTranscriptionWithBatching).toBe('function');
        expect(typeof MovieBotService.prototype.buildMoviePrompt).toBe('function');
        expect(typeof MovieBotService.prototype.getStatus).toBe('function');
        expect(typeof MovieBotService.prototype.updateConfig).toBe('function');
    });

    test('inherits base-class methods through the prototype chain', () => {
        expect(typeof MovieBotService.prototype.scheduleNextTranscription).toBe('function');
        expect(typeof MovieBotService.prototype.captureAndProcessTranscription).toBe('function');
        expect(typeof MovieBotService.prototype.validateMeaningfulTranscription).toBe('function');
        expect(typeof MovieBotService.prototype.logBotResponse).toBe('function');
        expect(typeof MovieBotService.prototype.enable).toBe('function');
        expect(typeof MovieBotService.prototype.disable).toBe('function');
    });
});
