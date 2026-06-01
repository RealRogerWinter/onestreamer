/**
 * Characterization net for StreamBotService.
 *
 * StreamBotService has no prior test coverage. This suite PINS the current
 * observable behavior before the service is decomposed into collaborators
 * under server/services/streambot/. It is written to pass against the CURRENT
 * service and must remain UNCHANGED across the decomposition commit.
 *
 * Strategy:
 *   - The service talks to SQLite through a node-sqlite3-style `db` object
 *     (db.get/db.all/db.run with node-style callbacks). We hand-roll a fake db
 *     whose methods invoke their callbacks deterministically.
 *   - sendToChatService() posts via axios; we jest.mock axios so no network
 *     traffic happens and we can assert the request shape.
 *   - Schedulers (setInterval/setTimeout) are exercised under jest fake timers.
 *   - Collaborator services (ChatBotService / ChatBotLLMService) are injected
 *     via the existing setters with hand-rolled mocks.
 *
 * Pins: DB query/arg shapes, return shapes, scheduling arm/cancel, gating on
 * enabled flags, character generation fallback branching, and announcement/
 * counter side-effects in auto-summon.
 */

jest.mock('../../bootstrap/logger', () => {
    const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
    m.child = jest.fn(() => m);
    return m;
});

jest.mock('axios', () => ({ post: jest.fn(async () => ({ data: { success: true } })) }));

const axios = require('axios');
const StreamBotService = require('../../services/StreamBotService');

/**
 * Build a fake node-sqlite3 db. `handlers` lets a test override the row(s)
 * returned for get/all and the lastID/changes seen by run callbacks.
 */
function makeDb(handlers = {}) {
    const get = jest.fn((sql, ...rest) => {
        const cb = rest[rest.length - 1];
        const params = rest.length > 1 ? rest[0] : undefined;
        const row = typeof handlers.get === 'function' ? handlers.get(sql, params) : handlers.get;
        cb(null, row === undefined ? undefined : row);
    });
    const all = jest.fn((sql, ...rest) => {
        const cb = rest[rest.length - 1];
        const params = rest.length > 1 ? rest[0] : undefined;
        const rows = typeof handlers.all === 'function' ? handlers.all(sql, params) : handlers.all;
        cb(null, rows === undefined ? [] : rows);
    });
    const run = jest.fn(function (sql, ...rest) {
        const cb = rest[rest.length - 1];
        // sqlite3 invokes the run callback with `this` carrying lastID/changes.
        const ctx = { lastID: handlers.lastID ?? 1, changes: handlers.changes ?? 1 };
        if (typeof cb === 'function') cb.call(ctx, null);
    });
    return { get, all, run };
}

function makeService(handlers = {}) {
    const db = makeDb(handlers);
    const service = new StreamBotService(db);
    return { service, db };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('StreamBotService characterization', () => {
    describe('construction', () => {
        it('unwraps a { db } wrapper, seeds timer fields to null, and loads the static archetype tables', () => {
            const inner = makeDb();
            const service = new StreamBotService({ db: inner });
            expect(service.db).toBe(inner);
            expect(service.intervalId).toBeNull();
            expect(service.autoSummonIntervalId).toBeNull();
            expect(service.autoSummonTimeoutId).toBeNull();
            expect(service.isInitialized).toBe(false);
            expect(service.characterArchetypes.length).toBeGreaterThan(0);
            expect(service.opposingPairs.length).toBeGreaterThan(0);
        });

        it('uses the raw db when no wrapper is passed', () => {
            const db = makeDb();
            const service = new StreamBotService(db);
            expect(service.db).toBe(db);
        });
    });

    describe('service setters', () => {
        it('store injected collaborator references', () => {
            const { service } = makeService();
            const chatBotService = {};
            const chatBotLLMService = {};
            service.setChatBotService(chatBotService);
            service.setChatBotLLMService(chatBotLLMService);
            expect(service.chatBotService).toBe(chatBotService);
            expect(service.chatBotLLMService).toBe(chatBotLLMService);
        });
    });

    describe('settings DB methods', () => {
        it('getSettings selects a single row from streambot_settings', async () => {
            const { service, db } = makeService({ get: { id: 1, enabled: 1 } });
            await expect(service.getSettings()).resolves.toEqual({ id: 1, enabled: 1 });
            expect(db.get).toHaveBeenCalledWith(
                'SELECT * FROM streambot_settings LIMIT 1',
                expect.any(Function)
            );
        });

        it('updateSettings builds a SET clause for id=1 and resolves the changed-row count', async () => {
            const { service, db } = makeService({ changes: 3 });
            const changes = await service.updateSettings({ enabled: 1, interval_minutes: 10 });
            expect(changes).toBe(3);
            const [sql, values] = db.run.mock.calls[0];
            expect(sql).toBe(
                'UPDATE streambot_settings SET enabled = ?, interval_minutes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
            );
            expect(values).toEqual([1, 10]);
        });

        it('updateSettings short-circuits with no run() when given no fields', async () => {
            const { service, db } = makeService();
            await expect(service.updateSettings({})).resolves.toBeUndefined();
            expect(db.run).not.toHaveBeenCalled();
        });
    });

    describe('message DB methods', () => {
        it('getMessages orders by order_index ASC', async () => {
            const rows = [{ id: 1 }, { id: 2 }];
            const { service, db } = makeService({ all: rows });
            await expect(service.getMessages()).resolves.toEqual(rows);
            expect(db.all).toHaveBeenCalledWith(
                'SELECT * FROM streambot_messages ORDER BY order_index ASC',
                expect.any(Function)
            );
        });

        it('getEnabledMessages filters to enabled=1', async () => {
            const { service, db } = makeService({ all: [{ id: 9, enabled: 1 }] });
            await expect(service.getEnabledMessages()).resolves.toEqual([{ id: 9, enabled: 1 }]);
            expect(db.all.mock.calls[0][0]).toContain('WHERE enabled = 1');
        });

        it('createMessage appends at the end (order_index = current count) and returns the new row', async () => {
            // getMessages returns 2 existing rows -> order_index should be 2.
            const { service, db } = makeService({ all: [{ id: 1 }, { id: 2 }], lastID: 42 });
            const result = await service.createMessage('hello');
            expect(result).toEqual({ id: 42, message: 'hello', enabled: 1, order_index: 2 });
            const insertCall = db.run.mock.calls[0];
            expect(insertCall[0]).toContain('INSERT INTO streambot_messages');
            expect(insertCall[1]).toEqual(['hello', 2]);
        });

        it('updateMessage strips the id field, appends updated_at, and targets WHERE id = ?', async () => {
            const { service, db } = makeService({ changes: 1 });
            await service.updateMessage(7, { id: 7, message: 'new', enabled: 0 });
            const [sql, values] = db.run.mock.calls[0];
            expect(sql).toBe(
                'UPDATE streambot_messages SET message = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            expect(values).toEqual(['new', 0, 7]);
        });

        it('deleteMessage issues a scoped DELETE and resolves the changes count', async () => {
            const { service, db } = makeService({ changes: 1 });
            await expect(service.deleteMessage(5)).resolves.toBe(1);
            expect(db.run.mock.calls[0][0]).toBe('DELETE FROM streambot_messages WHERE id = ?');
            expect(db.run.mock.calls[0][1]).toEqual([5]);
        });

        it('toggleMessage flips an enabled message to disabled', async () => {
            const { service, db } = makeService({ get: { id: 3, enabled: 1 }, changes: 1 });
            await service.toggleMessage(3);
            // The UPDATE issued by updateMessage should set enabled = 0.
            const updateCall = db.run.mock.calls.find((c) => /UPDATE streambot_messages/.test(c[0]));
            expect(updateCall[1]).toEqual([0, 3]);
        });

        it('toggleMessage throws when the message is missing', async () => {
            const { service } = makeService({ get: undefined });
            await expect(service.toggleMessage(99)).rejects.toThrow('Message not found');
        });

        it('reorderMessages updates order_index for each id by position', async () => {
            const { service, db } = makeService({ changes: 1 });
            await service.reorderMessages([30, 10, 20]);
            const orderCalls = db.run.mock.calls.filter((c) => /UPDATE streambot_messages/.test(c[0]));
            expect(orderCalls.map((c) => c[1])).toEqual([
                [0, 30],
                [1, 10],
                [2, 20],
            ]);
        });
    });

    describe('sendToChatService', () => {
        it('POSTs the message to the chat service system-message endpoint as StreamBot', async () => {
            const { service } = makeService();
            await service.sendToChatService('hi there');
            expect(axios.post).toHaveBeenCalledTimes(1);
            const [url, body] = axios.post.mock.calls[0];
            expect(url).toBe(`${service.chatServiceUrl}/api/system-message`);
            expect(body).toEqual({ message: 'hi there', username: '🤖 StreamBot' });
        });

        it('emits a local sendMessage fallback when the HTTP post rejects', async () => {
            axios.post.mockRejectedValueOnce(new Error('network down'));
            const { service } = makeService();
            const emitted = [];
            service.on('sendMessage', (m) => emitted.push(m));
            await service.sendToChatService('fallback msg');
            expect(emitted).toEqual(['fallback msg']);
        });
    });

    describe('sendNextMessage', () => {
        it('sends the message at current_message_index and advances the index (wrapping)', async () => {
            // settings -> current_message_index 1; 2 enabled messages -> next index 0.
            const settings = { enabled: 1, current_message_index: 1 };
            const messages = [{ message: 'm0' }, { message: 'm1' }];
            const { service, db } = makeService({
                get: settings,
                all: messages,
            });
            const sendSpy = jest.spyOn(service, 'sendToChatService').mockResolvedValue();
            const updateSpy = jest.spyOn(service, 'updateSettings').mockResolvedValue(1);

            await service.sendNextMessage();

            expect(sendSpy).toHaveBeenCalledWith('m1');
            expect(updateSpy).toHaveBeenCalledWith(
                expect.objectContaining({ current_message_index: 0 })
            );
            expect(db).toBeDefined();
        });

        it('does nothing when disabled', async () => {
            const { service } = makeService({ get: { enabled: 0 } });
            const sendSpy = jest.spyOn(service, 'sendToChatService').mockResolvedValue();
            await service.sendNextMessage();
            expect(sendSpy).not.toHaveBeenCalled();
        });

        it('returns early (no send) when there are no enabled messages', async () => {
            const { service } = makeService({ get: { enabled: 1, current_message_index: 0 }, all: [] });
            const sendSpy = jest.spyOn(service, 'sendToChatService').mockResolvedValue();
            await service.sendNextMessage();
            expect(sendSpy).not.toHaveBeenCalled();
        });
    });

    describe('periodic-message scheduling', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        it('startPeriodicMessages arms an interval when enabled and skips the immediate send if recently sent', async () => {
            const settings = {
                enabled: 1,
                interval_minutes: 5,
                last_sent_at: new Date().toISOString(),
            };
            const { service } = makeService({ get: settings });
            jest.spyOn(service, 'getSettings').mockResolvedValue(settings);
            const sendSpy = jest.spyOn(service, 'sendNextMessage').mockResolvedValue();

            await service.startPeriodicMessages();

            expect(service.intervalId).not.toBeNull();
            // last_sent_at is "now" so the immediate-send branch is skipped.
            expect(sendSpy).not.toHaveBeenCalled();
        });

        it('startPeriodicMessages does not arm an interval when disabled', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getSettings').mockResolvedValue({ enabled: 0 });
            await service.startPeriodicMessages();
            expect(service.intervalId).toBeNull();
        });

        it('stopPeriodicMessages clears the armed interval', async () => {
            const settings = { enabled: 1, interval_minutes: 5, last_sent_at: new Date().toISOString() };
            const { service } = makeService();
            jest.spyOn(service, 'getSettings').mockResolvedValue(settings);
            jest.spyOn(service, 'sendNextMessage').mockResolvedValue();
            await service.startPeriodicMessages();
            expect(service.intervalId).not.toBeNull();
            await service.stopPeriodicMessages();
            expect(service.intervalId).toBeNull();
        });
    });

    describe('toggleEnabled', () => {
        it('flips off and stops periodic messages when currently enabled', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getSettings').mockResolvedValue({ enabled: 1 });
            const updateSpy = jest.spyOn(service, 'updateSettings').mockResolvedValue(1);
            const stopSpy = jest.spyOn(service, 'stopPeriodicMessages').mockResolvedValue();
            const startSpy = jest.spyOn(service, 'startPeriodicMessages').mockResolvedValue();

            const result = await service.toggleEnabled();

            expect(result).toBe(0);
            expect(updateSpy).toHaveBeenCalledWith({ enabled: 0 });
            expect(stopSpy).toHaveBeenCalled();
            expect(startSpy).not.toHaveBeenCalled();
        });

        it('flips on and starts periodic messages when currently disabled', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getSettings').mockResolvedValue({ enabled: 0 });
            jest.spyOn(service, 'updateSettings').mockResolvedValue(1);
            const startSpy = jest.spyOn(service, 'startPeriodicMessages').mockResolvedValue();
            const result = await service.toggleEnabled();
            expect(result).toBe(1);
            expect(startSpy).toHaveBeenCalled();
        });
    });

    describe('auto-summon settings DB methods', () => {
        it('getAutoSummonSettings selects the id=1 row', async () => {
            const { service, db } = makeService({ get: { id: 1, enabled: 1 } });
            await expect(service.getAutoSummonSettings()).resolves.toEqual({ id: 1, enabled: 1 });
            expect(db.get).toHaveBeenCalledWith(
                'SELECT * FROM auto_summon_settings WHERE id = 1',
                expect.any(Function)
            );
        });

        it('updateAutoSummonSettings builds a SET clause against id=1', async () => {
            const { service, db } = makeService({ changes: 1 });
            await service.updateAutoSummonSettings({ total_summoned: 4 });
            const [sql, values] = db.run.mock.calls[0];
            expect(sql).toBe(
                'UPDATE auto_summon_settings SET total_summoned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1'
            );
            expect(values).toEqual([4]);
        });

        it('logAutoSummonedBot inserts into auto_summoned_bots and returns the new id', async () => {
            const { service, db } = makeService({ lastID: 77 });
            await expect(
                service.logAutoSummonedBot(5, 'bot', 'persona', 'prompt')
            ).resolves.toEqual({ id: 77 });
            const [sql, values] = db.run.mock.calls[0];
            expect(sql).toContain('INSERT INTO auto_summoned_bots');
            expect(values).toEqual([5, 'bot', 'persona', 'prompt']);
        });

        it('getAutoSummonedBotHistory orders by summoned_at DESC with a LIMIT', async () => {
            const { service, db } = makeService({ all: [{ id: 1 }] });
            await expect(service.getAutoSummonedBotHistory(5)).resolves.toEqual([{ id: 1 }]);
            const [sql, values] = db.all.mock.calls[0];
            expect(sql).toContain('ORDER BY summoned_at DESC');
            expect(values).toEqual([5]);
        });
    });

    describe('character generation fallback branching', () => {
        it('generateWhimsicalCharacter falls back when no LLM service is set', async () => {
            const { service } = makeService();
            const fallback = service.generateFallbackCharacter();
            const result = await service.generateWhimsicalCharacter();
            expect(result).toHaveProperty('name');
            expect(result).toHaveProperty('personality');
            // Same shape as the deterministic fallback set.
            expect(typeof fallback.name).toBe('string');
        });

        it('generateWhimsicalCharacter falls back when Groq is disabled', async () => {
            const { service } = makeService();
            service.setChatBotLLMService({
                getGroqStatus: () => ({ enabled: false, hasApiKey: false }),
                callGroqAPI: jest.fn(),
            });
            const result = await service.generateWhimsicalCharacter();
            expect(result).toHaveProperty('generatedPrompt', 'Fallback character (Groq unavailable)');
        });

        it('generateCharacterPair calls Groq with the 70b model and returns the parsed/truncated pair', async () => {
            const { service } = makeService();
            const callGroqAPIWithModel = jest.fn(async () => ({
                model: 'llama-3.3-70b-versatile',
                message: JSON.stringify({
                    positive: { name: 'sunny_sam', personality: 'cheery' },
                    negative: { name: 'grumpy_gus', personality: 'sour' },
                }),
            }));
            service.setChatBotLLMService({
                getGroqStatus: () => ({ enabled: true, hasApiKey: true }),
                callGroqAPIWithModel,
            });

            const pair = await service.generateCharacterPair();

            expect(callGroqAPIWithModel).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),
                'llama-3.3-70b-versatile',
                500,
                0.95
            );
            expect(pair.positive.name).toBe('sunny_sam');
            expect(pair.negative.name).toBe('grumpy_gus');
            expect(pair.positive).toHaveProperty('generatedPrompt');
        });

        it('generateCharacterPair falls back to a deterministic pair when Groq returns an empty message', async () => {
            const { service } = makeService();
            service.setChatBotLLMService({
                getGroqStatus: () => ({ enabled: true, hasApiKey: true }),
                callGroqAPIWithModel: jest.fn(async () => ({ message: '' })),
            });
            const pair = await service.generateCharacterPair();
            expect(pair.positive.generatedPrompt).toBe('Fallback pair (Groq unavailable)');
            expect(pair.negative.generatedPrompt).toBe('Fallback pair (Groq unavailable)');
        });
    });

    describe('autoSummonBot', () => {
        it('generates a pair, creates two temporary bots, logs them, bumps the counter by 2, and announces', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({
                enabled: 1,
                bot_duration_seconds: 120,
                total_summoned: 4,
            });
            const pair = {
                positive: { name: 'pos', personality: 'p', generatedPrompt: 'gp1' },
                negative: { name: 'neg', personality: 'n', generatedPrompt: 'gp2' },
            };
            jest.spyOn(service, 'generateCharacterPair').mockResolvedValue(pair);
            const createTemporaryBot = jest
                .fn()
                .mockResolvedValueOnce({ id: 11 })
                .mockResolvedValueOnce({ id: 22 });
            service.setChatBotService({ createTemporaryBot });
            const logSpy = jest.spyOn(service, 'logAutoSummonedBot').mockResolvedValue({ id: 1 });
            const updateSpy = jest.spyOn(service, 'updateAutoSummonSettings').mockResolvedValue(1);
            const sendSpy = jest.spyOn(service, 'sendToChatService').mockResolvedValue();

            await service.autoSummonBot();

            expect(createTemporaryBot).toHaveBeenCalledTimes(2);
            expect(createTemporaryBot.mock.calls[0][0]).toEqual(
                expect.objectContaining({ name: 'pos', llmModel: null, duration: 120 })
            );
            expect(logSpy).toHaveBeenCalledTimes(2);
            expect(updateSpy).toHaveBeenCalledWith(
                expect.objectContaining({ total_summoned: 6 })
            );
            expect(sendSpy).toHaveBeenCalledWith(expect.stringContaining('pos'));
        });

        it('returns early when ChatBotService is not set', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({ enabled: 1 });
            const genSpy = jest.spyOn(service, 'generateCharacterPair').mockResolvedValue(null);
            // chatBotService stays null
            await service.autoSummonBot();
            expect(genSpy).not.toHaveBeenCalled();
        });

        it('returns early when auto-summon is disabled', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({ enabled: 0 });
            const genSpy = jest.spyOn(service, 'generateCharacterPair').mockResolvedValue(null);
            await service.autoSummonBot();
            expect(genSpy).not.toHaveBeenCalled();
        });
    });

    describe('auto-summon scheduling', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());

        it('startAutoSummon summons immediately + arms an interval when overdue', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({
                enabled: 1,
                interval_minutes: 10,
                last_summoned_at: null, // never summoned -> overdue
            });
            const summonSpy = jest.spyOn(service, 'autoSummonBot').mockResolvedValue();

            await service.startAutoSummon();

            expect(summonSpy).toHaveBeenCalledTimes(1);
            expect(service.autoSummonIntervalId).not.toBeNull();
            expect(service.autoSummonTimeoutId).toBeNull();
        });

        it('startAutoSummon arms a delay timeout (no immediate summon) when not yet due', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({
                enabled: 1,
                interval_minutes: 10,
                last_summoned_at: new Date().toISOString(), // just summoned -> not due
            });
            const summonSpy = jest.spyOn(service, 'autoSummonBot').mockResolvedValue();

            await service.startAutoSummon();

            expect(summonSpy).not.toHaveBeenCalled();
            expect(service.autoSummonTimeoutId).not.toBeNull();
            expect(service.autoSummonIntervalId).toBeNull();
        });

        it('startAutoSummon does nothing when disabled', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({ enabled: 0 });
            await service.startAutoSummon();
            expect(service.autoSummonIntervalId).toBeNull();
            expect(service.autoSummonTimeoutId).toBeNull();
        });

        it('stopAutoSummon clears both the timeout and interval handles', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({
                enabled: 1,
                interval_minutes: 10,
                last_summoned_at: new Date().toISOString(),
            });
            jest.spyOn(service, 'autoSummonBot').mockResolvedValue();
            await service.startAutoSummon();
            expect(service.autoSummonTimeoutId).not.toBeNull();
            await service.stopAutoSummon();
            expect(service.autoSummonTimeoutId).toBeNull();
            expect(service.autoSummonIntervalId).toBeNull();
        });

        it('toggleAutoSummon flips on and starts the scheduler when currently disabled', async () => {
            const { service } = makeService();
            jest.spyOn(service, 'getAutoSummonSettings').mockResolvedValue({ enabled: 0 });
            jest.spyOn(service, 'updateAutoSummonSettings').mockResolvedValue(1);
            const startSpy = jest.spyOn(service, 'startAutoSummon').mockResolvedValue();
            const result = await service.toggleAutoSummon();
            expect(result).toBe(1);
            expect(startSpy).toHaveBeenCalled();
        });
    });

    describe('triggerManualAutoSummon', () => {
        it('delegates straight to autoSummonBot', async () => {
            const { service } = makeService();
            const summonSpy = jest.spyOn(service, 'autoSummonBot').mockResolvedValue('done');
            await expect(service.triggerManualAutoSummon()).resolves.toBe('done');
            expect(summonSpy).toHaveBeenCalledTimes(1);
        });
    });

    describe('lifecycle', () => {
        it('initialize starts both loops once and flips isInitialized', async () => {
            const { service } = makeService();
            const periodicSpy = jest.spyOn(service, 'startPeriodicMessages').mockResolvedValue();
            const autoSpy = jest.spyOn(service, 'startAutoSummon').mockResolvedValue();
            await service.initialize();
            expect(periodicSpy).toHaveBeenCalledTimes(1);
            expect(autoSpy).toHaveBeenCalledTimes(1);
            expect(service.isInitialized).toBe(true);
            // Second call is a no-op.
            await service.initialize();
            expect(periodicSpy).toHaveBeenCalledTimes(1);
        });

        it('stop tears down both loops', async () => {
            const { service } = makeService();
            const stopPeriodic = jest.spyOn(service, 'stopPeriodicMessages').mockResolvedValue();
            const stopAuto = jest.spyOn(service, 'stopAutoSummon').mockResolvedValue();
            await service.stop();
            expect(stopPeriodic).toHaveBeenCalledTimes(1);
            expect(stopAuto).toHaveBeenCalledTimes(1);
        });
    });
});
