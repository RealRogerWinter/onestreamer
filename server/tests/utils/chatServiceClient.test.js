// Tests for server/utils/chatServiceClient.js (audit CH3) — the shared
// axios-config helper every main→chat-service call site uses to attach the
// X-Internal-Secret header, the self-signed-tolerant https agent, and a
// default timeout.

const { chatServiceUrl, chatAxiosConfig } = require('../../utils/chatServiceClient');

describe('chatServiceUrl', () => {
  const saved = process.env.CHAT_SERVICE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_SERVICE_URL;
    else process.env.CHAT_SERVICE_URL = saved;
  });

  test('CHAT_SERVICE_URL env wins', () => {
    process.env.CHAT_SERVICE_URL = 'https://chat.internal:9999';
    expect(chatServiceUrl('https://127.0.0.1:8444')).toBe('https://chat.internal:9999');
  });

  test('per-call-site default is PRESERVED when env is unset (two divergent defaults exist today — deliberate, see helper header)', () => {
    delete process.env.CHAT_SERVICE_URL;
    expect(chatServiceUrl('https://onestreamer.live:8444')).toBe('https://onestreamer.live:8444');
    expect(chatServiceUrl('https://127.0.0.1:8444')).toBe('https://127.0.0.1:8444');
    expect(chatServiceUrl('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081');
  });
});

describe('chatAxiosConfig', () => {
  const savedSecret = process.env.INTERNAL_API_SECRET;
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = savedSecret;
  });

  test('attaches X-Internal-Secret when INTERNAL_API_SECRET is set', () => {
    process.env.INTERNAL_API_SECRET = 's3cret';
    const cfg = chatAxiosConfig('https://127.0.0.1:8444');
    expect(cfg.headers['X-Internal-Secret']).toBe('s3cret');
  });

  test('omits the header when INTERNAL_API_SECRET is unset', () => {
    delete process.env.INTERNAL_API_SECRET;
    const cfg = chatAxiosConfig('https://127.0.0.1:8444');
    expect(cfg.headers && cfg.headers['X-Internal-Secret']).toBeUndefined();
  });

  test('reads the env at call time (rotation without re-require)', () => {
    process.env.INTERNAL_API_SECRET = 'first';
    expect(chatAxiosConfig('https://x').headers['X-Internal-Secret']).toBe('first');
    process.env.INTERNAL_API_SECRET = 'second';
    expect(chatAxiosConfig('https://x').headers['X-Internal-Secret']).toBe('second');
  });

  test('default 5s timeout, overridable', () => {
    expect(chatAxiosConfig('https://x').timeout).toBe(5000);
    expect(chatAxiosConfig('https://x', { timeout: 250 }).timeout).toBe(250);
  });

  test('https target gets the self-signed-tolerant agent; http does not', () => {
    const httpsCfg = chatAxiosConfig('https://127.0.0.1:8444/api/ban');
    expect(httpsCfg.httpsAgent).toBeDefined();
    expect(httpsCfg.httpsAgent.options.rejectUnauthorized).toBe(false);
    const httpCfg = chatAxiosConfig('http://127.0.0.1:8081/api/ban');
    expect(httpCfg.httpsAgent).toBeUndefined();
  });

  test('caller-supplied httpsAgent and headers are preserved and merged', () => {
    process.env.INTERNAL_API_SECRET = 's3cret';
    const myAgent = { custom: true };
    const cfg = chatAxiosConfig('https://x', {
      httpsAgent: myAgent,
      headers: { 'Content-Type': 'application/json' },
      params: { since: 1 },
    });
    expect(cfg.httpsAgent).toBe(myAgent);
    expect(cfg.headers['Content-Type']).toBe('application/json');
    expect(cfg.headers['X-Internal-Secret']).toBe('s3cret');
    expect(cfg.params).toEqual({ since: 1 });
  });
});
