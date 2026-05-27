const ChatBotRepository = require('../../../database/repository/ChatBotRepository');

function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new ChatBotRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe('ChatBotRepository', () => {
    // ============================================================
    // chatbots
    // ============================================================

    describe('getEnabled', () => {
        it('SELECTs enabled chatbots via allAsync', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([{ id: 1 }, { id: 2 }]);
            const rows = await repo.getEnabled();
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM chatbots WHERE is_enabled = 1');
            expect(params).toBeUndefined();
            expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
        });
    });

    describe('getById', () => {
        it('passes id to getAsync', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 42, name: 'bot' });
            const row = await repo.getById(42);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM chatbots WHERE id = ?');
            expect(params).toEqual([42]);
            expect(row).toEqual({ id: 42, name: 'bot' });
        });
    });

    describe('getAll', () => {
        it('SELECTs all chatbots ORDER BY created_at DESC', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.getAll();
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM chatbots ORDER BY created_at DESC');
        });
    });

    describe('listForBulk', () => {
        it('SELECTs all chatbots without ordering', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listForBulk();
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM chatbots');
        });
    });

    describe('listSummary', () => {
        it('SELECTs id, name, is_enabled only', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listSummary();
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT id, name, is_enabled FROM chatbots');
        });
    });

    describe('getMovieBotEnabled', () => {
        it('SELECTs enabled bots with moviebot_enabled = 1', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.getMovieBotEnabled();
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM chatbots WHERE is_enabled = 1 AND moviebot_enabled = 1');
        });
    });

    describe('findExpiredTemporary', () => {
        it('SELECTs expired temporary bots using datetime() on both sides', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.findExpiredTemporary();
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                "SELECT id, name FROM chatbots WHERE is_temporary = 1 AND datetime(expires_at) < datetime('now')"
            );
        });
    });

    describe('create', () => {
        it('INSERTs with all 11 columns in the documented order', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 7, changes: 1 });

            const result = await repo.create({
                name: 'Bot7',
                prompt: 'be friendly',
                personality_traits: '{"a":1}',
                llm_model: 'mistral',
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO chatbots ( name, prompt, is_enabled, response_interval_min, response_interval_max, show_robot_emoji, personality_traits, use_assigned_name, llm_model, moviebot_enabled, response_creativity_temperature ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            // Documented defaults from the legacy createBot SQL: is_enabled=1,
            // response_interval_min=60, response_interval_max=180,
            // show_robot_emoji=1, use_assigned_name=1, moviebot_enabled=0,
            // response_creativity_temperature=0.7.
            expect(params).toEqual([
                'Bot7', 'be friendly', 1, 60, 180, 1, '{"a":1}', 1, 'mistral', 0, 0.7,
            ]);
            expect(result).toEqual({ id: 7, changes: 1 });
        });
    });

    describe('createTemporary', () => {
        it('INSERTs with the temporary-bot column shape', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 11, changes: 1 });

            await repo.createTemporary({
                name: 'Temp',
                prompt: 'combined prompt',
                summoned_by_user_id: 123,
                expires_at: '2026-05-27T01:00:00.000Z',
                summon_item_id: 5,
                llm_model: 'openai',
                response_creativity_temperature: 0.8,
            });

            const [sql, params] = runAsync.mock.calls[0];
            // 14 columns in the legacy createTemporaryBot SQL (4 are literals
            // in the VALUES clause: is_enabled=1, is_temporary=1,
            // moviebot_enabled=1, use_assigned_name=1, response_interval_min=30,
            // response_interval_max=90, show_robot_emoji=1 are baked in).
            expect(norm(sql)).toContain('INSERT INTO chatbots');
            expect(norm(sql)).toContain('VALUES (?, ?, 1, 1, ?, ?, ?, 1, 1, 30, 90, 1, ?, ?)');
            expect(params).toEqual([
                'Temp', 'combined prompt', 123, '2026-05-27T01:00:00.000Z', 5, 'openai', 0.8,
            ]);
        });
    });

    describe('updateFields', () => {
        it('builds SET clause from object keys; always appends updated_at = CURRENT_TIMESTAMP', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.updateFields(42, { name: 'newName', is_enabled: 1 });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE chatbots SET name = ?, is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            expect(params).toEqual(['newName', 1, 42]);
        });

        it('with empty fields object still bumps updated_at (observable no-op)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.updateFields(7, {});

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE chatbots SET updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            expect(params).toEqual([7]);
        });
    });

    describe('setEnabled', () => {
        it.each([
            [true, 1],
            [false, 0],
            [1, 1],
            [0, 0],
        ])('coerces %p to %p via ternary', async (input, expected) => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.setEnabled(5, input);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('UPDATE chatbots SET is_enabled = ? WHERE id = ?');
            expect(params).toEqual([expected, 5]);
        });
    });

    describe('enableAll / disableAll', () => {
        it('enableAll updates without filter', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 3 });
            await repo.enableAll();
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('UPDATE chatbots SET is_enabled = 1');
            expect(params).toBeUndefined();
        });

        it('disableAll updates without filter', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 3 });
            await repo.disableAll();
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('UPDATE chatbots SET is_enabled = 0');
            expect(params).toBeUndefined();
        });
    });

    describe('deleteById / deleteTemporaryById', () => {
        it('deleteById removes by primary key', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.deleteById(99);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM chatbots WHERE id = ?');
            expect(params).toEqual([99]);
        });

        it('deleteTemporaryById guards on is_temporary = 1', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 0 });
            await repo.deleteTemporaryById(100);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM chatbots WHERE id = ? AND is_temporary = 1');
            expect(params).toEqual([100]);
        });
    });

    // ============================================================
    // chatbot_sessions
    // ============================================================

    describe('createSession', () => {
        it('INSERTs (chatbot_id, socket_id, username, color)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 17, changes: 1 });

            const result = await repo.createSession({
                chatbotId: 3,
                socketId: 'sock-abc',
                username: 'Lion42',
                color: '#FF0000',
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO chatbot_sessions (chatbot_id, socket_id, username, color) VALUES (?, ?, ?, ?)'
            );
            expect(params).toEqual([3, 'sock-abc', 'Lion42', '#FF0000']);
            expect(result).toEqual({ id: 17, changes: 1 });
        });
    });

    describe('markSessionDisconnected', () => {
        it('NULLs socket_id by session id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.markSessionDisconnected(17);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('UPDATE chatbot_sessions SET socket_id = NULL WHERE id = ?');
            expect(params).toEqual([17]);
        });
    });

    describe('touchSessionLastMessage', () => {
        it('bumps last_message_at to CURRENT_TIMESTAMP', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.touchSessionLastMessage(17);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE chatbot_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            expect(params).toEqual([17]);
        });
    });

    describe('deleteSessionsForBot / deleteAllSessions', () => {
        it('deleteSessionsForBot filters by chatbot_id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 2 });
            await repo.deleteSessionsForBot(8);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM chatbot_sessions WHERE chatbot_id = ?');
            expect(params).toEqual([8]);
        });

        it('deleteAllSessions has no filter', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 5 });
            await repo.deleteAllSessions();
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM chatbot_sessions');
            expect(params).toBeUndefined();
        });
    });

    describe('listConnectedSessions / listActiveSessionsWithBot', () => {
        it('listConnectedSessions filters by socket_id IS NOT NULL', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listConnectedSessions();
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM chatbot_sessions WHERE socket_id IS NOT NULL');
        });

        it('listActiveSessionsWithBot JOINs chatbots and selects bot_name/show_robot_emoji', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.listActiveSessionsWithBot();
            const [sql] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT s.*, b.name as bot_name, b.show_robot_emoji FROM chatbot_sessions s JOIN chatbots b ON s.chatbot_id = b.id WHERE s.socket_id IS NOT NULL ORDER BY s.connected_at DESC'
            );
        });
    });

    // ============================================================
    // chatbot_message_history
    // ============================================================

    describe('getLastMessageForBot', () => {
        it('SELECTs message, created_at ORDER BY created_at DESC LIMIT 1', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ message: 'hi', created_at: '2026-01-01' });
            await repo.getLastMessageForBot(7);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT message, created_at FROM chatbot_message_history WHERE chatbot_id = ? ORDER BY created_at DESC LIMIT 1'
            );
            expect(params).toEqual([7]);
        });
    });

    describe('insertChatMessage', () => {
        it('INSERTs (chatbot_id, message, context, exact_prompt)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 200, changes: 1 });
            await repo.insertChatMessage({
                chatbotId: 7,
                message: 'Hello',
                context: '[]',
                exactPrompt: 'prompt-text',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO chatbot_message_history (chatbot_id, message, context, exact_prompt) VALUES (?, ?, ?, ?)'
            );
            expect(params).toEqual([7, 'Hello', '[]', 'prompt-text']);
        });
    });

    describe('insertMovieComment', () => {
        it('INSERTs with message_type=movie_comment', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 201, changes: 1 });
            await repo.insertMovieComment({
                chatbotId: 7,
                message: 'movie thought',
                metadata: '{"x":1}',
                exactPrompt: 'movie-prompt',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO chatbot_message_history (chatbot_id, message, message_type, metadata, exact_prompt) VALUES (?, ?, ?, ?, ?)'
            );
            expect(params).toEqual([7, 'movie thought', 'movie_comment', '{"x":1}', 'movie-prompt']);
        });
    });

    describe('getMessages', () => {
        it('SELECTs by chatbot_id ORDER BY created_at DESC LIMIT ?', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.getMessages(7, 50);
            const [sql, params] = allAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM chatbot_message_history WHERE chatbot_id = ? ORDER BY created_at DESC LIMIT ?'
            );
            expect(params).toEqual([7, 50]);
        });

        it('defaults limit to 50', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);
            await repo.getMessages(7);
            const [, params] = allAsync.mock.calls[0];
            expect(params).toEqual([7, 50]);
        });
    });

    // ============================================================
    // temporary_bots
    // ============================================================

    describe('getTemporaryBotInfo', () => {
        it('SELECTs by chatbot_id', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue(null);
            await repo.getTemporaryBotInfo(7);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM temporary_bots WHERE chatbot_id = ?');
            expect(params).toEqual([7]);
        });
    });

    describe('createTemporaryRecord', () => {
        it('INSERTs five columns', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 1, changes: 1 });
            await repo.createTemporaryRecord({
                chatbotId: 7,
                summonedByUserId: 100,
                summonedByUsername: 'Alice',
                personalityPrompt: 'sleepy',
                expiresAt: '2026-05-27T01:00:00.000Z',
            });
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'INSERT INTO temporary_bots ( chatbot_id, summoned_by_user_id, summoned_by_username, personality_prompt, expires_at ) VALUES (?, ?, ?, ?, ?)'
            );
            expect(params).toEqual([7, 100, 'Alice', 'sleepy', '2026-05-27T01:00:00.000Z']);
        });
    });

    describe('deleteTemporaryRecord', () => {
        it('DELETEs by chatbot_id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.deleteTemporaryRecord(7);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM temporary_bots WHERE chatbot_id = ?');
            expect(params).toEqual([7]);
        });
    });

    // ============================================================
    // auto_summoned_bots
    // ============================================================

    describe('deleteAutoSummonedForBot', () => {
        it('DELETEs by chatbot_id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });
            await repo.deleteAutoSummonedForBot(7);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM auto_summoned_bots WHERE chatbot_id = ?');
            expect(params).toEqual([7]);
        });
    });

    // ============================================================
    // Constructor / dep injection
    // ============================================================

    describe('constructor', () => {
        it('falls back to the real database primitives when no deps passed', () => {
            // Just confirm it doesn't throw — the real primitives are
            // exported as functions from database.js even when the schema
            // bootstrap hasn't completed.
            const repo = new ChatBotRepository();
            expect(typeof repo.getAsync).toBe('function');
            expect(typeof repo.runAsync).toBe('function');
            expect(typeof repo.allAsync).toBe('function');
        });

        it('uses injected primitives in preference to the fallback', () => {
            const getAsync = jest.fn();
            const runAsync = jest.fn();
            const allAsync = jest.fn();
            const repo = new ChatBotRepository({ getAsync, runAsync, allAsync });
            expect(repo.getAsync).toBe(getAsync);
            expect(repo.runAsync).toBe(runAsync);
            expect(repo.allAsync).toBe(allAsync);
        });
    });
});
