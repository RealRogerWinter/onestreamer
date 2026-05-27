// Tests for ChatBotLLMService.callGroqAPIWithImage / generateVisionComment.
// global.fetch is mocked so the suite doesn't make real Groq calls and
// doesn't need GROQ_API_KEY to be set.

// ChatBotLLMService imports the real database module at module load, which
// runs `initializeDatabase()` with cascading setTimeouts for schema setup.
// Mock it to keep the test environment clean — none of these vision tests
// touch the DB.
jest.mock('../../database/database', () => ({
    runAsync: jest.fn(),
    getAsync: jest.fn(),
    allAsync: jest.fn(),
    db: null,
}));

// Ollama client is instantiated in the constructor and would try to dial
// localhost:11434 during health checks. Stub it.
jest.mock('ollama', () => ({
    Ollama: class { constructor() {} },
}));

const ChatBotLLMService = require('../../services/ChatBotLLMService');
const { GroqRateLimitError, GroqUnavailableError } = ChatBotLLMService;

const SAMPLE_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64');

function mockFetch(response) {
    global.fetch = jest.fn(async () => response);
}

function okResponse(message = 'a person is on screen') {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: message } }] }),
        text: async () => 'ok',
    };
}

describe('ChatBotLLMService — vision', () => {
    let svc;
    beforeEach(() => {
        svc = new ChatBotLLMService();
        svc.groqApiKey = 'test-key';
    });
    afterEach(() => {
        delete global.fetch;
    });

    test('callGroqAPIWithImage builds an OpenAI-compatible messages array with image_url + data URI', async () => {
        mockFetch(okResponse('A streamer is talking.'));
        const result = await svc.callGroqAPIWithImage({
            systemPrompt: 'sys',
            userPrompt: 'what do you see?',
            imageBase64: SAMPLE_JPEG_B64,
        });
        expect(result.message).toBe('A streamer is talking.');
        expect(result.model).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [, init] = global.fetch.mock.calls[0];
        const body = JSON.parse(init.body);
        expect(body.model).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
        expect(body.stream).toBe(false);
        expect(body.messages).toHaveLength(2);
        const userMsg = body.messages[1];
        expect(userMsg.role).toBe('user');
        expect(Array.isArray(userMsg.content)).toBe(true);
        expect(userMsg.content[0]).toEqual({ type: 'text', text: 'what do you see?' });
        expect(userMsg.content[1].type).toBe('image_url');
        expect(userMsg.content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
        expect(userMsg.content[1].image_url.url).toContain(SAMPLE_JPEG_B64);
        // Authorization header sent but never present in the response/error
        // path. Sanity check it's present in the request.
        expect(init.headers.Authorization).toBe('Bearer test-key');
    });

    test('throws GroqRateLimitError on 429 and surfaces retry-after header', async () => {
        mockFetch({
            ok: false,
            status: 429,
            headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '42' : null) },
            json: async () => ({}),
            text: async () => 'rate limited',
        });
        await expect(svc.callGroqAPIWithImage({
            systemPrompt: 's', userPrompt: 'u', imageBase64: SAMPLE_JPEG_B64,
        })).rejects.toThrow(GroqRateLimitError);

        // re-do for retryAfter inspection
        mockFetch({
            ok: false,
            status: 429,
            headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '42' : null) },
            json: async () => ({}),
            text: async () => 'rate limited',
        });
        try {
            await svc.callGroqAPIWithImage({
                systemPrompt: 's', userPrompt: 'u', imageBase64: SAMPLE_JPEG_B64,
            });
            throw new Error('expected throw');
        } catch (e) {
            expect(e).toBeInstanceOf(GroqRateLimitError);
            expect(e.status).toBe(429);
            expect(e.retryAfterSeconds).toBe(42);
            expect(e.model).toBe('meta-llama/llama-4-scout-17b-16e-instruct');
        }
    });

    test('throws GroqUnavailableError on 5xx', async () => {
        mockFetch({
            ok: false,
            status: 503,
            headers: { get: () => null },
            json: async () => ({}),
            text: async () => 'upstream down',
        });
        await expect(svc.callGroqAPIWithImage({
            systemPrompt: 's', userPrompt: 'u', imageBase64: SAMPLE_JPEG_B64,
        })).rejects.toThrow(GroqUnavailableError);
    });

    test('throws GroqUnavailableError on network error and does NOT leak Authorization header in console output', async () => {
        const consoleErr = jest.spyOn(console, 'error').mockImplementation(() => {});
        global.fetch = jest.fn(async () => { throw new Error('socket hang up'); });
        try {
            await expect(svc.callGroqAPIWithImage({
                systemPrompt: 's', userPrompt: 'u', imageBase64: SAMPLE_JPEG_B64,
            })).rejects.toThrow(GroqUnavailableError);

            // The console.error call must not contain the API key OR the
            // Authorization header value anywhere in its args.
            for (const call of consoleErr.mock.calls) {
                const joined = call.map(a => (a && a.toString) ? a.toString() : String(a)).join(' ');
                expect(joined).not.toContain('test-key');
                expect(joined).not.toContain('Bearer ');
            }
        } finally {
            consoleErr.mockRestore();
        }
    });

    test('propagates AbortSignal cancellation', async () => {
        const ac = new AbortController();
        global.fetch = jest.fn(async (_, init) => {
            // Simulate fetch checking the abort signal: if it's already
            // aborted, throw the way real fetch does.
            if (init.signal && init.signal.aborted) {
                const e = new Error('aborted');
                e.name = 'AbortError';
                throw e;
            }
            // Hand back a fake never-resolving promise by waiting on the
            // signal, then throwing.
            return await new Promise((_, reject) => {
                init.signal.addEventListener('abort', () => {
                    const e = new Error('aborted');
                    e.name = 'AbortError';
                    reject(e);
                });
            });
        });
        const promise = svc.callGroqAPIWithImage({
            systemPrompt: 's', userPrompt: 'u', imageBase64: SAMPLE_JPEG_B64, abortSignal: ac.signal,
        });
        ac.abort();
        await expect(promise).rejects.toThrow(GroqUnavailableError);
    });

    test('throws when imageBase64 is missing', async () => {
        await expect(svc.callGroqAPIWithImage({
            systemPrompt: 's', userPrompt: 'u',
        })).rejects.toThrow(/imageBase64/);
    });

    test('throws when API key not configured', async () => {
        svc.groqApiKey = null;
        await expect(svc.callGroqAPIWithImage({
            systemPrompt: 's', userPrompt: 'u', imageBase64: SAMPLE_JPEG_B64,
        })).rejects.toThrow(/Groq API key not configured/);
    });
});

describe('ChatBotLLMService.generateVisionComment', () => {
    let svc;
    beforeEach(() => {
        svc = new ChatBotLLMService();
        svc.groqApiKey = 'test-key';
    });
    afterEach(() => {
        delete global.fetch;
    });

    test('embeds the safety preamble in the system prompt', async () => {
        mockFetch(okResponse('Looks like a stream.'));
        await svc.generateVisionComment({
            botPrompt: 'You are a friendly viewer.',
            imageBase64: SAMPLE_JPEG_B64,
            transcription: 'hello stream',
            chatHistory: [],
            username: 'TheComedian',
        });
        const [, init] = global.fetch.mock.calls[0];
        const body = JSON.parse(init.body);
        const sysMsg = body.messages[0];
        expect(sysMsg.role).toBe('system');
        expect(sysMsg.content).toMatch(/untrusted user content/i);
        expect(sysMsg.content).toContain('You are a friendly viewer.');
    });

    test('returns a redacted exactPrompt that omits raw chat history and transcription text', async () => {
        mockFetch(okResponse('looks good.'));
        const r = await svc.generateVisionComment({
            botPrompt: 'B',
            imageBase64: SAMPLE_JPEG_B64,
            transcription: 'private user said something sensitive',
            chatHistory: [
                { username: 'alice', message: 'a message that contains PII' },
                { username: 'bob', message: 'another' },
            ],
            personality: { name: 'TheComedian' },
            username: 'TheComedian',
        });
        expect(r.message).toBe('looks good.');
        const ep = r.exactPrompt;
        expect(typeof ep).toBe('object');
        // Must include structural metadata but NOT raw PII.
        expect(ep.systemPromptLength).toBeGreaterThan(0);
        expect(ep.userPromptLength).toBeGreaterThan(0);
        expect(ep.chatHistoryCount).toBe(2);
        expect(ep.transcriptionLength).toBe('private user said something sensitive'.length);
        expect(ep.username).toBe('TheComedian');
        // No raw fields:
        expect(JSON.stringify(ep)).not.toContain('alice');
        expect(JSON.stringify(ep)).not.toContain('private user');
    });

    test('honors a custom model when passed', async () => {
        mockFetch(okResponse('x'));
        await svc.generateVisionComment({
            botPrompt: 'B',
            imageBase64: SAMPLE_JPEG_B64,
            model: 'meta-llama/llama-4-scout-different',
        });
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.model).toBe('meta-llama/llama-4-scout-different');
    });
});
