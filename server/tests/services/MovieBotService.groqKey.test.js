// A7 (audit Plan 07): the Groq API key had two divergent sources of truth —
// `groq_config.api_key` (canonical, admin-managed via /admin/groq/config) and
// `moviebot_config.groq_api_key` (legacy). MovieBotService used to overwrite
// the LLM service's key with its own table's copy on every config load, and
// its admin config route persisted new keys into moviebot_config. These tests
// pin the fix: groq_config is the single source of truth; the legacy column
// is only read once, to migrate an old install's key into groq_config.

const MovieBotService = require('../../services/MovieBotService');

// Build a MovieBotService without running its constructor (which schedules a
// deferred loadConfigFromDatabase and creates a log directory). We only need
// the prototype methods plus the state they touch.
function makeBot({ groqConfigRow = undefined, config = {} } = {}) {
    const bot = Object.create(MovieBotService.prototype);
    bot.botName = 'MovieBotService';
    bot.configTableName = 'moviebot_config';
    bot.defaultPromptTemplate = 'tmpl [TRANSCRIPTION_DATA]';
    bot.config = {
        enabled: false,
        transcriptionDuration: 45,
        transcriptionFrequency: 120,
        chatHistoryLimit: 30,
        useGroq: false,
        messageDelay: { min: 4000, max: 8000 },
        moviePromptTemplate: 'tmpl',
        ...config,
    };
    bot.currentStreamerId = null;
    bot.promptHistory = [];
    bot._groqConfigRow = groqConfigRow; // what SELECT ... FROM groq_config returns
    bot.db = {
        get: jest.fn((sql, cb) => cb(null, bot._groqConfigRow)),
        run: jest.fn((sql, params, cb) => { if (cb) cb(null); }),
    };
    bot.chatBotService = {
        llmService: {
            groqApiKey: null,
            saveGroqConfig: jest.fn(),
            enableGroq: jest.fn(() => true),
            disableGroq: jest.fn(() => true),
        },
    };
    bot.logEvent = jest.fn(); // don't write bot log files from tests
    return bot;
}

describe('MovieBotService Groq key single-source-of-truth (A7)', () => {
    describe('afterConfigLoaded', () => {
        test('does NOT clobber the llmService key when groq_config already has one (both keys set)', () => {
            const bot = makeBot({
                groqConfigRow: { api_key: 'canonical-groq-key' },
                config: { useGroq: true },
            });
            const llm = bot.chatBotService.llmService;
            llm.groqApiKey = 'canonical-groq-key'; // loaded from groq_config

            bot.afterConfigLoaded({ groq_api_key: 'stale-legacy-key', use_groq: 1 });

            expect(llm.groqApiKey).toBe('canonical-groq-key'); // old code set 'stale-legacy-key'
            expect(llm.saveGroqConfig).not.toHaveBeenCalled(); // no re-write of groq_config
            // useGroq still turns Groq on — with the canonical key (no arg override)
            expect(llm.enableGroq).toHaveBeenCalledTimes(1);
            expect(llm.enableGroq).toHaveBeenCalledWith();
        });

        test('migrates a legacy moviebot_config key into groq_config when groq_config has none', () => {
            const bot = makeBot({ groqConfigRow: undefined }); // no groq_config row yet
            const llm = bot.chatBotService.llmService;

            bot.afterConfigLoaded({ groq_api_key: 'legacy-only-key', use_groq: 0 });

            expect(llm.groqApiKey).toBe('legacy-only-key');
            expect(llm.saveGroqConfig).toHaveBeenCalledTimes(1); // persisted into groq_config
            expect(llm.enableGroq).not.toHaveBeenCalled(); // useGroq is off

            // Second load (post-migration groq_config now holds the key):
            // no further migration writes — one-time only.
            bot._groqConfigRow = { api_key: 'legacy-only-key' };
            bot.afterConfigLoaded({ groq_api_key: 'legacy-only-key', use_groq: 0 });
            expect(llm.saveGroqConfig).toHaveBeenCalledTimes(1);
        });

        test('migration also handles a groq_config row that exists with a NULL api_key', () => {
            const bot = makeBot({
                groqConfigRow: { api_key: null },
                config: { useGroq: true },
            });
            const llm = bot.chatBotService.llmService;

            bot.afterConfigLoaded({ groq_api_key: 'legacy-key', use_groq: 1 });

            expect(llm.groqApiKey).toBe('legacy-key');
            expect(llm.saveGroqConfig).toHaveBeenCalledTimes(1);
            expect(llm.enableGroq).toHaveBeenCalledWith();
        });

        test('no legacy key: leaves the llmService key alone entirely', () => {
            const bot = makeBot({ groqConfigRow: { api_key: 'canonical-groq-key' } });
            const llm = bot.chatBotService.llmService;
            llm.groqApiKey = 'canonical-groq-key';

            bot.afterConfigLoaded({ groq_api_key: null, use_groq: 0 });

            expect(llm.groqApiKey).toBe('canonical-groq-key');
            expect(llm.saveGroqConfig).not.toHaveBeenCalled();
            expect(bot.db.get).not.toHaveBeenCalled(); // no migration probe needed
        });
    });

    describe('updateConfig (admin /admin/moviebot/config write path)', () => {
        test('persists an admin-supplied key into groq_config, not moviebot_config', () => {
            const bot = makeBot();
            const llm = bot.chatBotService.llmService;

            const result = bot.updateConfig({ groqApiKey: 'new-admin-key' });

            // Key landed on the service and was saved via the groq_config store
            expect(llm.groqApiKey).toBe('new-admin-key');
            expect(llm.saveGroqConfig).toHaveBeenCalledTimes(1);

            // moviebot_config write no longer touches groq_api_key
            expect(bot.db.run).toHaveBeenCalledTimes(1);
            const [query, params] = bot.db.run.mock.calls[0];
            expect(query).not.toMatch(/groq_api_key/);
            expect(params).not.toContain('new-admin-key');

            // Response shape preserved for the admin route
            expect(result).toEqual({ success: true, config: bot.config });
        });

        test('useGroq toggle still enables/disables Groq via the llmService', () => {
            const bot = makeBot();
            const llm = bot.chatBotService.llmService;

            bot.updateConfig({ useGroq: true, groqApiKey: 'key-1' });
            expect(llm.enableGroq).toHaveBeenCalledWith('key-1');
            expect(bot.config.useGroq).toBe(true);

            bot.updateConfig({ useGroq: false });
            expect(llm.disableGroq).toHaveBeenCalledTimes(1);
            expect(bot.config.useGroq).toBe(false);
        });

        test('does not write the raw API key into the moviebot event log', () => {
            const bot = makeBot();
            bot.updateConfig({ groqApiKey: 'super-secret-key' });
            expect(bot.logEvent).toHaveBeenCalledWith(
                'CONFIG_UPDATED',
                expect.objectContaining({ groqApiKey: '[REDACTED]' })
            );
            expect(JSON.stringify(bot.logEvent.mock.calls)).not.toContain('super-secret-key');
        });
    });
});
