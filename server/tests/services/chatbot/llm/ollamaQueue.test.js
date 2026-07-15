// Audit A6 (Plan 07): OllamaQueue tests for the chat timeout, queue max-age,
// and saturated-model skip. No network — the ollama client is a stub.

const { OllamaQueue } = require('../../../../services/chatbot/llm/ollamaQueue');

const noopLogger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn() };

function makeQueue({ chat, timeoutMs } = {}) {
    if (timeoutMs !== undefined) {
        process.env.OLLAMA_TIMEOUT_MS = String(timeoutMs);
    }
    return new OllamaQueue({
        ollama: { chat: chat || jest.fn() },
        availableModels: [],
        logger: noopLogger,
        cleanResponse: (m) => m,
        getFallbackResponse: () => 'fallback-response',
    });
}

function neverSettles() {
    return new Promise(() => {});
}

describe('OllamaQueue timeouts and queue hygiene (audit A6)', () => {
    afterEach(() => {
        delete process.env.OLLAMA_TIMEOUT_MS;
        jest.clearAllMocks();
    });

    test('OLLAMA_TIMEOUT_MS env override with 60s default and 2x queue max-age', () => {
        const q1 = makeQueue();
        expect(q1.OLLAMA_TIMEOUT_MS).toBe(60000);
        expect(q1.QUEUE_MAX_AGE_MS).toBe(120000);
        const q2 = makeQueue({ timeoutMs: 500 });
        expect(q2.OLLAMA_TIMEOUT_MS).toBe(500);
        expect(q2.QUEUE_MAX_AGE_MS).toBe(1000);
    });

    test('chatWithTimeout rejects when ollama.chat hangs, resolves when it is fast', async () => {
        const q = makeQueue({ chat: jest.fn(() => neverSettles()), timeoutMs: 30 });
        await expect(q.chatWithTimeout({ model: 'm1', messages: [] }))
            .rejects.toThrow(/timed out after 30ms.*m1/);

        const fast = makeQueue({
            chat: jest.fn(async () => ({ message: { content: 'quick' } })),
            timeoutMs: 30,
        });
        await expect(fast.chatWithTimeout({ model: 'm1', messages: [] }))
            .resolves.toEqual({ message: { content: 'quick' } });
    });

    test('a timed-out queued chat resolves with the fallback and releases its slot', async () => {
        const chat = jest.fn(() => neverSettles());
        const q = makeQueue({ chat, timeoutMs: 30 });

        const resultPromise = q.queueRequest('modelA', 'sys', 'user', {}, {}, 'prompt');
        await q.processQueue();

        const result = await resultPromise;
        expect(result.message).toBe('fallback-response');
        expect(result.error).toMatch(/timed out/);
        expect(result.queued).toBe(true);
        // In-flight bookkeeping decremented — no slot leak.
        expect(q.activeRequests.get('modelA')).toBe(0);
        expect(q.requestQueue).toHaveLength(0);
    });

    test('an aged-out queue entry resolves with the fallback without calling ollama', async () => {
        const chat = jest.fn(async () => ({ message: { content: 'hi' } }));
        const q = makeQueue({ chat, timeoutMs: 50 });

        const resultPromise = q.queueRequest('modelA', 'sys', 'user', {}, {}, 'prompt');
        // Backdate the entry past the max age (2x timeout = 100ms).
        q.requestQueue[0].timestamp = Date.now() - q.QUEUE_MAX_AGE_MS - 1;

        await q.processQueue();

        const result = await resultPromise;
        expect(result.message).toBe('fallback-response');
        expect(result.error).toMatch(/aged out/);
        expect(chat).not.toHaveBeenCalled();
        expect(q.requestQueue).toHaveLength(0);
    });

    test('a saturated model does not block other models\' queued requests', async () => {
        const chat = jest.fn(async ({ model }) => ({ message: { content: `reply-from-${model}` } }));
        const q = makeQueue({ chat, timeoutMs: 5000 });

        // Saturate modelA (e.g. by direct, non-queued calls elsewhere).
        q.activeRequests.set('modelA', q.MAX_CONCURRENT_PER_MODEL);

        const aPromise = q.queueRequest('modelA', 'sys', 'user', {}, {}, 'pA');
        const bPromise = q.queueRequest('modelB', 'sys', 'user', {}, {}, 'pB');

        await q.processQueue();

        // modelB was processed despite modelA (queued ahead of it) being saturated.
        const bResult = await bPromise;
        expect(bResult.message).toBe('reply-from-modelB');
        expect(chat).toHaveBeenCalledTimes(1);
        expect(chat.mock.calls[0][0].model).toBe('modelB');

        // modelA's request is still queued, not dropped.
        expect(q.requestQueue).toHaveLength(1);
        expect(q.requestQueue[0].model).toBe('modelA');

        // Once modelA frees up, its request drains normally.
        q.activeRequests.set('modelA', 0);
        await q.processQueue();
        const aResult = await aPromise;
        expect(aResult.message).toBe('reply-from-modelA');
    });

    test('processQueue clears the processing flag even when a chat rejects', async () => {
        const chat = jest.fn(async () => { throw new Error('boom'); });
        const q = makeQueue({ chat, timeoutMs: 5000 });

        const resultPromise = q.queueRequest('modelA', 'sys', 'user', {}, {}, 'p');
        await q.processQueue();

        const result = await resultPromise;
        expect(result.message).toBe('fallback-response');
        expect(result.error).toBe('boom');
        expect(q.processing).toBe(false);
        expect(q.activeRequests.get('modelA')).toBe(0);
    });
});
