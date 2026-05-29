// Characterization tests for the ChatBotService response pipeline
// (scheduleNextResponse + generateAndSendMessage) before extracting the pure
// policy helpers (expiry predicate, interval calc, personality build).

jest.mock('../../services/ChatBotLLMService', () => jest.fn(() => ({})));

const ChatBotService = require('../../services/ChatBotService');

function botInstance(overrides = {}) {
  const { data: dataOverrides, ...rest } = overrides;
  return {
    id: 7,
    connected: true,
    username: 'Rex_Lion',
    sessionId: 'sess-1',
    messageHistory: [{ role: 'user', content: 'hi' }],
    responseTimer: null,
    socket: { emit: jest.fn() },
    ...rest,
    data: {
      is_enabled: 1,
      is_temporary: 0,
      expires_at: null,
      moviebot_enabled: 0,
      vision_bot_enabled: 0,
      prompt: 'be a viewer',
      llm_model: 'llama',
      personality_traits: null,
      response_creativity_temperature: 0.8,
      response_interval_min: 10,
      response_interval_max: 20,
      ...dataOverrides,
    },
  };
}

describe('ChatBotService response pipeline', () => {
  let svc;
  let repo;

  beforeEach(() => {
    jest.useFakeTimers();
    repo = {
      insertChatMessage: jest.fn().mockResolvedValue(),
      touchSessionLastMessage: jest.fn().mockResolvedValue(),
      findExpiredTemporary: jest.fn().mockResolvedValue([]),
    };
    svc = new ChatBotService({ chatBotRepository: repo });
    svc.isInitialized = true;
    svc.llmService = { generateResponse: jest.fn().mockResolvedValue({ message: 'hello chat', exactPrompt: 'P' }) };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('scheduleNextResponse', () => {
    test('does not schedule when disabled or disconnected', () => {
      const b1 = botInstance({ data: { is_enabled: 0 } });
      svc.scheduleNextResponse(b1);
      expect(b1.responseTimer).toBeNull();
    });

    test('does not schedule for moviebot/vision bots', () => {
      const mb = botInstance({ data: { moviebot_enabled: 1 } });
      const vb = botInstance({ data: { vision_bot_enabled: 1 } });
      svc.scheduleNextResponse(mb);
      svc.scheduleNextResponse(vb);
      expect(mb.responseTimer).toBeNull();
      expect(vb.responseTimer).toBeNull();
    });

    test('expired temp bot is disabled + triggers cleanup, no timer', () => {
      const cleanup = jest.spyOn(svc, 'cleanupExpiredBots').mockResolvedValue(0);
      const b = botInstance({ data: { is_temporary: 1, expires_at: new Date(Date.now() - 1000).toISOString() } });
      svc.scheduleNextResponse(b);
      expect(b.data.is_enabled).toBe(0);
      expect(b.connected).toBe(false);
      expect(cleanup).toHaveBeenCalled();
      expect(b.responseTimer).toBeNull();
    });

    test('normal bot schedules a timer that fires generateAndSendMessage then reschedules', async () => {
      const gen = jest.spyOn(svc, 'generateAndSendMessage').mockResolvedValue();
      const b = botInstance();
      svc.scheduleNextResponse(b);
      expect(b.responseTimer).not.toBeNull(); // interval in [10s,20s]
      await jest.advanceTimersByTimeAsync(20_000);
      expect(gen).toHaveBeenCalledWith(b);
    });
  });

  describe('generateAndSendMessage', () => {
    test('generates with personality(+temperature) and emits + logs on success', async () => {
      const b = botInstance({ data: { personality_traits: JSON.stringify({ tone: 'snarky' }) } });
      await svc.generateAndSendMessage(b);

      expect(svc.llmService.generateResponse).toHaveBeenCalledWith(
        'be a viewer',
        b.messageHistory,
        { tone: 'snarky', temperature: 0.8 },
        'llama',
        'Rex_Lion'
      );
      expect(b.socket.emit).toHaveBeenCalledWith('send-message', { message: 'hello chat' });
      expect(repo.insertChatMessage).toHaveBeenCalled();
      expect(repo.touchSessionLastMessage).toHaveBeenCalledWith('sess-1');
    });

    test('skips entirely when disabled', async () => {
      const b = botInstance({ data: { is_enabled: 0 } });
      await svc.generateAndSendMessage(b);
      expect(svc.llmService.generateResponse).not.toHaveBeenCalled();
      expect(b.socket.emit).not.toHaveBeenCalled();
    });

    test('expired temp bot disables, clears timer, triggers cleanup, no LLM call', async () => {
      const cleanup = jest.spyOn(svc, 'cleanupExpiredBots').mockResolvedValue(0);
      const b = botInstance({ responseTimer: setTimeout(() => {}, 99999), data: { is_temporary: 1, expires_at: new Date(Date.now() - 1000).toISOString() } });
      await svc.generateAndSendMessage(b);
      expect(svc.llmService.generateResponse).not.toHaveBeenCalled();
      expect(b.data.is_enabled).toBe(0);
      expect(b.responseTimer).toBeNull();
      expect(cleanup).toHaveBeenCalled();
    });
  });
});
