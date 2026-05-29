// Characterization tests for the ChatBotService temp-bot lifecycle
// (createTemporaryBot / scheduleExpiration / cleanupExpiredBots). Pins behavior
// before extracting the shared helpers (prompt/expiry computation + the
// delete-records sequence + bot-instance quiesce).

jest.mock('../../services/ChatBotLLMService', () => jest.fn(() => ({})));

const ChatBotService = require('../../services/ChatBotService');

function makeRepo() {
  return {
    createTemporary: jest.fn().mockResolvedValue({ id: 7 }),
    getById: jest.fn().mockResolvedValue({ id: 7, name: 'Temp', is_temporary: 1 }),
    createTemporaryRecord: jest.fn().mockResolvedValue(),
    findExpiredTemporary: jest.fn().mockResolvedValue([]),
    deleteAutoSummonedForBot: jest.fn().mockResolvedValue(),
    deleteTemporaryRecord: jest.fn().mockResolvedValue(),
    deleteTemporaryById: jest.fn().mockResolvedValue(),
    deleteById: jest.fn().mockResolvedValue(),
  };
}

describe('ChatBotService temp-bot lifecycle', () => {
  let svc;
  let repo;

  beforeEach(() => {
    jest.useFakeTimers();
    repo = makeRepo();
    svc = new ChatBotService({ chatBotRepository: repo, getMoviePromptTemplate: () => 'MOVIE_PROMPT' });
    svc.isInitialized = true;
    jest.spyOn(svc, 'startBot').mockResolvedValue();
    jest.spyOn(svc, 'stopBot').mockResolvedValue();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('createTemporaryBot', () => {
    test('builds the combined prompt, computes expiry, persists, starts, schedules', async () => {
      const bot = await svc.createTemporaryBot({
        name: 'Rex', personalityPrompt: 'snarky', summonedBy: 9, duration: 100,
      });
      expect(bot).toEqual({ id: 7, name: 'Temp', is_temporary: 1 });

      const created = repo.createTemporary.mock.calls[0][0];
      expect(created.name).toBe('Rex');
      expect(created.prompt).toBe('MOVIE_PROMPT\n\nYour specific personality: snarky\nYour name is Rex.');
      // expires_at = now + duration*1000 (fake timers freeze "now")
      expect(created.expires_at).toBe(new Date(Date.now() + 100 * 1000).toISOString());

      expect(repo.createTemporaryRecord).toHaveBeenCalled();
      expect(svc.startBot).toHaveBeenCalledWith({ id: 7, name: 'Temp', is_temporary: 1 });
    });
  });

  describe('scheduleExpiration', () => {
    test('after the duration: stops the bot and deletes records (deleteTemporaryById)', async () => {
      svc.scheduleExpiration(42, 5);
      await jest.advanceTimersByTimeAsync(5000);

      expect(svc.stopBot).toHaveBeenCalledWith(42);
      expect(repo.deleteAutoSummonedForBot).toHaveBeenCalledWith(42);
      expect(repo.deleteTemporaryRecord).toHaveBeenCalledWith(42);
      expect(repo.deleteTemporaryById).toHaveBeenCalledWith(42);
      expect(repo.deleteById).not.toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredBots', () => {
    test('returns 0 and does nothing when none are expired', async () => {
      repo.findExpiredTemporary.mockResolvedValue([]);
      expect(await svc.cleanupExpiredBots()).toBe(0);
      expect(svc.stopBot).not.toHaveBeenCalled();
    });

    test('quiesces the live instance and deletes records in order (deleteById)', async () => {
      repo.findExpiredTemporary.mockResolvedValue([{ id: 7, name: 'Temp' }]);
      const order = [];
      repo.deleteAutoSummonedForBot.mockImplementation(() => { order.push('auto'); });
      repo.deleteTemporaryRecord.mockImplementation(() => { order.push('temp'); });
      repo.deleteById.mockImplementation(() => { order.push('byId'); });

      const inst = { responseTimer: setTimeout(() => {}, 999999), data: { is_enabled: 1 }, connected: true };
      svc.bots.set(7, inst);

      const n = await svc.cleanupExpiredBots();

      expect(n).toBe(1);
      expect(svc.stopBot).toHaveBeenCalledWith(7);
      expect(order).toEqual(['auto', 'temp', 'byId']);
      expect(repo.deleteTemporaryById).not.toHaveBeenCalled();
      expect(inst.responseTimer).toBeNull();
      expect(inst.data.is_enabled).toBe(0);
      expect(inst.connected).toBe(false);
    });

    test('returns 0 on repo error', async () => {
      repo.findExpiredTemporary.mockRejectedValue(new Error('db'));
      expect(await svc.cleanupExpiredBots()).toBe(0);
    });
  });
});
