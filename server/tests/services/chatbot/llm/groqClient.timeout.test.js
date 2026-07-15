// Audit A6 (Plan 07): Groq fetches used to run with no abort signal, so a
// hung upstream pinned the caller forever. These tests pin the fix: every
// fetch carries a GROQ_TIMEOUT_MS-based timeout signal, combined with any
// caller-supplied signal so either can abort. No network involved — fetch is
// replaced with a stub that only settles when its signal aborts.

const {
    GroqClient,
    GroqUnavailableError,
    groqTimeoutMs,
    withTimeoutSignal,
} = require('../../../../services/chatbot/llm/groqClient');

const noopLogger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn() };

function makeClient() {
    return new GroqClient({
        getApiKey: () => 'test-key',
        getModel: () => 'test-model',
        getApiUrl: () => 'https://groq.invalid/v1/chat/completions',
        logger: noopLogger,
    });
}

// A fetch that never resolves on its own; it only rejects when the abort
// signal passed by the client fires (mirrors undici's abort behavior).
function hangingFetch() {
    return jest.fn((url, opts) => new Promise((resolve, reject) => {
        expect(opts.signal).toBeDefined();
        if (opts.signal.aborted) {
            reject(opts.signal.reason);
            return;
        }
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
    }));
}

describe('Groq fetch timeout (audit A6)', () => {
    const origFetch = global.fetch;

    afterEach(() => {
        global.fetch = origFetch;
        delete process.env.GROQ_TIMEOUT_MS;
        jest.clearAllMocks();
    });

    test('groqTimeoutMs: env override with sane default', () => {
        delete process.env.GROQ_TIMEOUT_MS;
        expect(groqTimeoutMs()).toBe(30000);
        process.env.GROQ_TIMEOUT_MS = '1234';
        expect(groqTimeoutMs()).toBe(1234);
        process.env.GROQ_TIMEOUT_MS = 'garbage';
        expect(groqTimeoutMs()).toBe(30000);
        process.env.GROQ_TIMEOUT_MS = '-5';
        expect(groqTimeoutMs()).toBe(30000);
    });

    test('callGroqAPI aborts when the request hangs past GROQ_TIMEOUT_MS', async () => {
        process.env.GROQ_TIMEOUT_MS = '40';
        global.fetch = hangingFetch();
        const client = makeClient();
        await expect(client.callGroqAPI('sys', 'user')).rejects.toMatchObject({
            name: expect.stringMatching(/TimeoutError|AbortError/),
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('callGroqAPIWithModel passes a timeout signal to fetch', async () => {
        process.env.GROQ_TIMEOUT_MS = '40';
        global.fetch = hangingFetch();
        const client = makeClient();
        await expect(client.callGroqAPIWithModel('sys', 'user', 'big-model')).rejects.toMatchObject({
            name: expect.stringMatching(/TimeoutError|AbortError/),
        });
    });

    test('callGroqAPIWithImage times out and wraps in GroqUnavailableError when no caller signal given', async () => {
        process.env.GROQ_TIMEOUT_MS = '40';
        global.fetch = hangingFetch();
        const client = makeClient();
        await expect(client.callGroqAPIWithImage({
            systemPrompt: 's',
            userPrompt: 'u',
            imageBase64: 'aGk=',
        })).rejects.toBeInstanceOf(GroqUnavailableError);
    });

    test('callGroqAPIWithImage: caller abort still works alongside the timeout', async () => {
        process.env.GROQ_TIMEOUT_MS = '600000'; // huge, so only the caller signal can fire
        global.fetch = hangingFetch();
        const client = makeClient();
        const controller = new AbortController();
        const call = client.callGroqAPIWithImage({
            systemPrompt: 's',
            userPrompt: 'u',
            imageBase64: 'aGk=',
            abortSignal: controller.signal,
        });
        setTimeout(() => controller.abort(new Error('caller aborted')), 10);
        await expect(call).rejects.toBeInstanceOf(GroqUnavailableError);
        await expect(call).rejects.toThrow(/caller aborted/);
    });

    describe('withTimeoutSignal', () => {
        test('returns a plain timeout signal when no caller signal is given', async () => {
            const signal = withTimeoutSignal(null, 20);
            expect(signal.aborted).toBe(false);
            await new Promise((resolve) => {
                signal.addEventListener('abort', resolve, { once: true });
            });
            expect(signal.aborted).toBe(true);
        });

        test('combined signal aborts when the caller signal fires first', () => {
            const controller = new AbortController();
            const signal = withTimeoutSignal(controller.signal, 600000);
            expect(signal.aborted).toBe(false);
            controller.abort(new Error('boom'));
            expect(signal.aborted).toBe(true);
        });

        test('combined signal aborts when the timeout fires first', async () => {
            const controller = new AbortController();
            const signal = withTimeoutSignal(controller.signal, 20);
            await new Promise((resolve) => {
                signal.addEventListener('abort', resolve, { once: true });
            });
            expect(signal.aborted).toBe(true);
        });

        test('an already-aborted caller signal yields an aborted combined signal', () => {
            const controller = new AbortController();
            controller.abort(new Error('pre-aborted'));
            const signal = withTimeoutSignal(controller.signal, 600000);
            expect(signal.aborted).toBe(true);
        });
    });
});
