// Characterization tests for ChatBotService.getMovieBotEnabledBots — pins the
// current behavior before extracting the filtering logic. ChatBotService had no
// test coverage; this also establishes the mocking pattern (inject a fake repo,
// auto-mock the LLM service, fake timers to suppress the 10s auto-init).

// Explicit no-op mock so the real LLM service module (and its lazy ollama/
// transformers imports) never loads — avoids "import after teardown" leaks.
jest.mock('../../services/ChatBotLLMService', () => jest.fn(() => ({})));

const ChatBotService = require('../../services/ChatBotService');

describe('ChatBotService.getMovieBotEnabledBots', () => {
  let svc;
  let repo;

  beforeEach(() => {
    jest.useFakeTimers(); // the constructor arms a 10s auto-init timer; don't let it fire
    repo = { getMovieBotEnabled: jest.fn() };
    svc = new ChatBotService({ chatBotRepository: repo });
    svc.isInitialized = true; // no-op the deferred auto-init if its timer ever fires
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const connect = (botId, username) => svc.bots.set(botId, { connected: true, username });

  test('includes only connected bots, in the {id,username,name,model} shape', async () => {
    repo.getMovieBotEnabled.mockResolvedValue([
      { id: 'b1', name: 'Alpha', llm_model: 'llama-3.1-8b-instant', is_temporary: 0 },
      { id: 'b2', name: 'Beta', llm_model: 'gpt', is_temporary: 0 }, // not connected -> excluded
    ]);
    connect('b1', 'Alpha_Lion');

    const result = await svc.getMovieBotEnabledBots();
    expect(result).toEqual([
      { id: 'b1', username: 'Alpha_Lion', name: 'Alpha', model: 'llama-3.1-8b-instant' },
    ]);
  });

  test('excludes expired temporary bots but keeps unexpired ones', async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    repo.getMovieBotEnabled.mockResolvedValue([
      { id: 'exp', name: 'Expired', llm_model: 'm', is_temporary: 1, expires_at: past },
      { id: 'liv', name: 'Live', llm_model: 'm', is_temporary: 1, expires_at: future },
    ]);
    connect('exp', 'Expired_x');
    connect('liv', 'Live_y');

    const result = await svc.getMovieBotEnabledBots();
    expect(result.map(b => b.id)).toEqual(['liv']);
  });

  test('a non-temporary bot is never expired', async () => {
    repo.getMovieBotEnabled.mockResolvedValue([
      { id: 'perm', name: 'Perm', llm_model: 'm', is_temporary: 0, expires_at: null },
    ]);
    connect('perm', 'Perm_z');
    const result = await svc.getMovieBotEnabledBots();
    expect(result.map(b => b.id)).toEqual(['perm']);
  });

  test('returns [] when the repository throws', async () => {
    repo.getMovieBotEnabled.mockRejectedValue(new Error('db down'));
    await expect(svc.getMovieBotEnabledBots()).resolves.toEqual([]);
  });
});
