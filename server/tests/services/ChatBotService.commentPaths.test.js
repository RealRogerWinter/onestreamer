// Characterization tests for the MovieBot + VisionBot comment paths
// (generateMovieComment / generateVisionCommentForBot) before deduping their
// temp-expiry checks (-> isBotExpired) and personality builds (movie ->
// buildResponsePersonality WITH temperature; vision -> parsePersonalityTraits
// WITHOUT temperature, since vision passes temperature separately).

jest.mock('../../services/ChatBotLLMService', () => jest.fn(() => ({})));

const ChatBotService = require('../../services/ChatBotService');

describe('ChatBotService comment paths', () => {
  let svc;
  let repo;

  beforeEach(() => {
    jest.useFakeTimers();
    repo = { insertMovieComment: jest.fn().mockResolvedValue(), findExpiredTemporary: jest.fn().mockResolvedValue([]) };
    svc = new ChatBotService({ chatBotRepository: repo });
    svc.isInitialized = true;
    jest.spyOn(svc, 'cleanupExpiredBots').mockResolvedValue(0);
    svc.llmService = {
      generateMovieResponse: jest.fn().mockResolvedValue({ message: 'movie!', exactPrompt: 'P' }),
      generateVisionComment: jest.fn().mockResolvedValue({ message: 'vision!', exactPrompt: { systemPromptLength: 1, userPromptLength: 2 }, model: 'scout' }),
    };
    svc.moderationService = { checkBotOutput: jest.fn().mockResolvedValue({ allowed: true }) };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function addBot(id, dataOverrides = {}) {
    const inst = {
      id,
      connected: true,
      username: `Bot_${id}`,
      socket: { emit: jest.fn(), once: jest.fn(), id: 'sock-1', connected: true },
      data: {
        is_temporary: 0, expires_at: null,
        personality_traits: JSON.stringify({ tone: 'wry' }),
        response_creativity_temperature: 0.8,
        prompt: 'be a viewer', llm_model: 'llama',
        ...dataOverrides,
      },
    };
    svc.bots.set(id, inst);
    return inst;
  }

  describe('generateMovieComment', () => {
    test('bot not found -> failure', async () => {
      const r = await svc.generateMovieComment({ id: 99, username: 'X' }, 'transcript', []);
      expect(r).toEqual({ success: false, error: 'Bot not found in active bots' });
    });

    test('expired temp bot -> cleanup + failure', async () => {
      addBot(1, { is_temporary: 1, expires_at: new Date(Date.now() - 1000).toISOString() });
      const r = await svc.generateMovieComment({ id: 1, username: 'Bot_1' }, 'transcript', []);
      expect(r).toEqual({ success: false, error: 'Bot has expired' });
      expect(svc.cleanupExpiredBots).toHaveBeenCalled();
    });

    test('happy path: personality WITH temperature, emits + persists + success', async () => {
      addBot(1);
      const r = await svc.generateMovieComment({ id: 1, username: 'Bot_1' }, 'the transcript', [{ x: 1 }]);
      expect(svc.llmService.generateMovieResponse).toHaveBeenCalledWith(
        'be a viewer', 'the transcript', [{ x: 1 }], { tone: 'wry', temperature: 0.8 }, 'llama', 'Bot_1'
      );
      const inst = svc.bots.get(1);
      expect(inst.socket.emit).toHaveBeenCalledWith('send-message', expect.objectContaining({ message: 'movie!' }));
      expect(repo.insertMovieComment).toHaveBeenCalled();
      expect(r.success).toBe(true);
      expect(r.message).toBe('movie!');
    });

    test('moderation drop -> failure with moderation_dropped reason', async () => {
      addBot(1);
      svc.moderationService.checkBotOutput.mockResolvedValue({ allowed: false, reason: 'slur', eventId: 'e9' });
      const r = await svc.generateMovieComment({ id: 1, username: 'Bot_1' }, 't', []);
      expect(r).toEqual({ success: false, error: 'moderation_dropped:slur', moderation_event_id: 'e9' });
      expect(svc.bots.get(1).socket.emit).not.toHaveBeenCalled();
    });
  });

  describe('generateVisionCommentForBot', () => {
    const frame = { jpegBase64: 'b64', sourceSegment: 'seg1', sizeBytes: 100, capturedAt: 't0' };

    test('happy path: personality WITHOUT temperature, emits + success', async () => {
      addBot(2);
      const r = await svc.generateVisionCommentForBot({
        bot: { id: 2, username: 'Bot_2' }, frame, transcription: 'tx', chatHistory: [],
        model: 'scout', maxTokens: 50, temperature: 0.5,
      });
      const callArg = svc.llmService.generateVisionComment.mock.calls[0][0];
      expect(callArg.personality).toEqual({ tone: 'wry' }); // NO temperature key
      expect(svc.bots.get(2).socket.emit).toHaveBeenCalledWith('send-message', expect.objectContaining({ message: 'vision!' }));
      expect(r).toEqual(expect.objectContaining({ success: true, message: 'vision!' }));
    });

    test('expired temp bot -> cleanup + failure', async () => {
      addBot(2, { is_temporary: 1, expires_at: new Date(Date.now() - 1000).toISOString() });
      const r = await svc.generateVisionCommentForBot({ bot: { id: 2, username: 'Bot_2' }, frame, transcription: 't', chatHistory: [] });
      expect(r).toEqual({ success: false, error: 'Bot has expired' });
      expect(svc.cleanupExpiredBots).toHaveBeenCalled();
    });

    test('moderation drop -> throws moderation_dropped', async () => {
      addBot(2);
      svc.moderationService.checkBotOutput.mockResolvedValue({ allowed: false, reason: 'nsfw' });
      await expect(svc.generateVisionCommentForBot({ bot: { id: 2, username: 'Bot_2' }, frame, transcription: 't', chatHistory: [] }))
        .rejects.toThrow('moderation_dropped:nsfw');
    });

    test('stream-takeover mismatch -> throws streamer_changed', async () => {
      addBot(2);
      await expect(svc.generateVisionCommentForBot({
        bot: { id: 2, username: 'Bot_2' }, frame, transcription: 't', chatHistory: [],
        streamService: { streamGeneration: 5 }, sourceStreamGeneration: 4,
      })).rejects.toThrow('streamer_changed');
    });
  });
});
