// Tests for server/services/GameMechanicsService — game-mechanic primitives
// extracted from server/routes/internal.js in PR 16.2.
//
// Coverage:
//   - Constructor contract (rejects missing deps; identity-binds the
//     cooldown Map by reference).
//   - gamble: win path (Math.random < 0.5), lose path, insufficient balance.
//   - slots: jackpot (7×3), diamond (💎×3), generic 3-of-a-kind, 2-of-a-kind
//     break-even (no ledger entry), lose, insufficient balance.
//   - claimChatBonus: happy path (awards 100, stamps cooldown, returns
//     nextBonusDelay/nextBonusTime), cooldown rejection (429 + extras).
//   - getBonusStatus: available (no prior claim, prior claim past cooldown),
//     on-cooldown (returns remainingSeconds + nextAvailable).
//   - transferPoints: happy path, sender-not-found 404, recipient-not-found
//     404, self-transfer 400, insufficient-balance 400. Falls back to DB
//     username when senderUsername arg is missing.
//
// The service delegates to AccountService; we stub it with jest.fn so the
// audit-row arguments stay assertable without dragging in the SQLite fixture.

jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

const GameMechanicsService = require('../../services/GameMechanicsService');
const { GameMechanicsError, CHAT_BONUS_COOLDOWN_MS, CHAT_BONUS_AMOUNT } = GameMechanicsService;

function makeAccountStub({
  balance = 1000,
  user = { id: 42, username: 'sender' },
  targetUser = { id: 99, username: 'recipient' },
  userByIdOverride,
  userByUsernameOverride,
} = {}) {
  return {
    getPointsBalance: jest.fn().mockResolvedValue(balance),
    addPoints: jest.fn().mockImplementation((userId, amount, _type, _desc, _meta) => Promise.resolve(balance + amount)),
    subtractPoints: jest.fn().mockImplementation((userId, amount, _type, _desc, _meta) => Promise.resolve(balance - amount)),
    getUserById: jest.fn().mockResolvedValue(userByIdOverride !== undefined ? userByIdOverride : user),
    getUserByUsername: jest.fn().mockResolvedValue(userByUsernameOverride !== undefined ? userByUsernameOverride : targetUser),
  };
}

describe('GameMechanicsService', () => {
  describe('constructor', () => {
    it('throws when accountService is missing', () => {
      expect(() => new GameMechanicsService({ userBonusCooldowns: new Map() }))
        .toThrow(/requires accountService/);
    });

    it('throws when userBonusCooldowns is missing or not a Map', () => {
      const accountService = makeAccountStub();
      expect(() => new GameMechanicsService({ accountService }))
        .toThrow(/requires userBonusCooldowns Map/);
      expect(() => new GameMechanicsService({ accountService, userBonusCooldowns: {} }))
        .toThrow(/requires userBonusCooldowns Map/);
    });

    it('stores the cooldown Map by reference (mutations visible to outside readers)', () => {
      const accountService = makeAccountStub();
      const shared = new Map();
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: shared });
      svc.userBonusCooldowns.set(42, 12345);
      expect(shared.get(42)).toBe(12345);
    });
  });

  describe('gamble', () => {
    let randomSpy;
    afterEach(() => randomSpy?.mockRestore());

    it('win path: addPoints with gamble_win type; returns won=true', async () => {
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.1); // < 0.5 → win
      const accountService = makeAccountStub({ balance: 1000 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.gamble(42, 250);

      expect(result).toEqual({ won: true, amount: 250, newBalance: 1250 });
      expect(accountService.addPoints).toHaveBeenCalledWith(
        42, 250, 'gamble_win', 'Won 250 points gambling', { amount: 250, result: 'win' }
      );
      expect(accountService.subtractPoints).not.toHaveBeenCalled();
    });

    it('lose path: subtractPoints with gamble_loss type; returns won=false', async () => {
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.9); // ≥ 0.5 → lose
      const accountService = makeAccountStub({ balance: 1000 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.gamble(42, 250);

      expect(result).toEqual({ won: false, amount: 250, newBalance: 750 });
      expect(accountService.subtractPoints).toHaveBeenCalledWith(
        42, 250, 'gamble_loss', 'Lost 250 points gambling', { amount: 250, result: 'loss' }
      );
      expect(accountService.addPoints).not.toHaveBeenCalled();
    });

    it('throws GameMechanicsError(400) on insufficient balance; no ledger write', async () => {
      const accountService = makeAccountStub({ balance: 50 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      await expect(svc.gamble(42, 250)).rejects.toMatchObject({
        statusCode: 400,
        clientMessage: 'Insufficient points. You have 50 points',
      });
      expect(accountService.addPoints).not.toHaveBeenCalled();
      expect(accountService.subtractPoints).not.toHaveBeenCalled();
    });
  });

  describe('slots', () => {
    let randomSpy;
    afterEach(() => randomSpy?.mockRestore());

    // SLOT_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '💎', '7️⃣']
    function rigSpins(values) {
      // values is an array of fractional positions in [0, 1) used by the
      // three Math.random calls — Math.floor(v * 6) picks the index.
      let i = 0;
      randomSpy = jest.spyOn(Math, 'random').mockImplementation(() => values[i++ % values.length]);
    }

    it('jackpot 7×3: 10× bet via addPoints(slots_win) with profit = 9× bet', async () => {
      rigSpins([5 / 6 + 0.001, 5 / 6 + 0.001, 5 / 6 + 0.001]); // index 5 → '7️⃣'
      const accountService = makeAccountStub({ balance: 1000 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.slots(42, 100);

      expect(result.symbols).toEqual(['7️⃣', '7️⃣', '7️⃣']);
      expect(result.winAmount).toBe(1000);
      expect(accountService.addPoints).toHaveBeenCalledWith(
        42, 900, 'slots_win', 'Won 900 points on slots',
        { bet: 100, symbols: '7️⃣7️⃣7️⃣', winAmount: 1000 }
      );
    });

    it('diamond 💎×3: 5× bet → addPoints with profit = 4× bet', async () => {
      rigSpins([4 / 6 + 0.001, 4 / 6 + 0.001, 4 / 6 + 0.001]); // index 4 → '💎'
      const accountService = makeAccountStub({ balance: 1000 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.slots(42, 100);

      expect(result.symbols).toEqual(['💎', '💎', '💎']);
      expect(result.winAmount).toBe(500);
      expect(accountService.addPoints).toHaveBeenCalledWith(
        42, 400, 'slots_win', 'Won 400 points on slots',
        { bet: 100, symbols: '💎💎💎', winAmount: 500 }
      );
    });

    it('generic 3-of-kind (cherry): 3× bet → addPoints with profit = 2× bet', async () => {
      rigSpins([0, 0, 0]); // index 0 → '🍒'
      const accountService = makeAccountStub({ balance: 1000 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.slots(42, 100);

      expect(result.symbols).toEqual(['🍒', '🍒', '🍒']);
      expect(result.winAmount).toBe(300);
      expect(accountService.addPoints).toHaveBeenCalledWith(
        42, 200, 'slots_win', 'Won 200 points on slots',
        { bet: 100, symbols: '🍒🍒🍒', winAmount: 300 }
      );
    });

    it('2-of-a-kind break-even: returns currentBalance with NO ledger write', async () => {
      rigSpins([0, 0, 1 / 6 + 0.001]); // ['🍒', '🍒', '🍋']
      const accountService = makeAccountStub({ balance: 1000 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.slots(42, 100);

      expect(result.symbols).toEqual(['🍒', '🍒', '🍋']);
      expect(result.winAmount).toBe(100);
      expect(result.newBalance).toBe(1000);
      expect(accountService.addPoints).not.toHaveBeenCalled();
      expect(accountService.subtractPoints).not.toHaveBeenCalled();
    });

    it('lose path (3 distinct): subtractPoints with slots_loss type', async () => {
      rigSpins([0, 1 / 6 + 0.001, 2 / 6 + 0.001]); // ['🍒', '🍋', '🍊']
      const accountService = makeAccountStub({ balance: 1000 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.slots(42, 100);

      expect(result.symbols).toEqual(['🍒', '🍋', '🍊']);
      expect(result.winAmount).toBe(0);
      expect(accountService.subtractPoints).toHaveBeenCalledWith(
        42, 100, 'slots_loss', 'Lost 100 points on slots',
        { bet: 100, symbols: '🍒🍋🍊', winAmount: 0 }
      );
    });

    it('throws GameMechanicsError(400) on insufficient balance', async () => {
      const accountService = makeAccountStub({ balance: 50 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      await expect(svc.slots(42, 100)).rejects.toMatchObject({
        statusCode: 400,
        clientMessage: 'Insufficient points. You have 50 points',
      });
    });
  });

  describe('claimChatBonus', () => {
    let nowSpy;
    let randomSpy;
    afterEach(() => {
      nowSpy?.mockRestore();
      randomSpy?.mockRestore();
    });

    it('happy path: awards 100, stamps cooldown, returns nextBonus* fields', async () => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      // 50% midpoint of the [120000, 360000) delay window
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const accountService = makeAccountStub({ balance: 1000 });
      const cooldowns = new Map();
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: cooldowns });

      const result = await svc.claimChatBonus(42);

      expect(accountService.addPoints).toHaveBeenCalledWith(
        42, CHAT_BONUS_AMOUNT, 'chat_bonus', 'Chat activity bonus',
        { source: 'chat_bonus_icon' }
      );
      expect(cooldowns.get(42)).toBe(1_000_000);
      // 0.5 * 240000 → 120000; + 120000 floor → 240000
      expect(result.pointsAwarded).toBe(100);
      expect(result.nextBonusDelay).toBe(240_000);
      expect(result.newBalance).toBe(1100);
      expect(result.nextBonusTime).toBe(new Date(1_240_000).toISOString());
    });

    it('cooldown rejection: throws 429 with remainingSeconds + nextAvailable', async () => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const accountService = makeAccountStub({ balance: 1000 });
      const cooldowns = new Map([[42, 1_000_000 - 30_000]]); // claimed 30s ago
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: cooldowns });

      await expect(svc.claimChatBonus(42)).rejects.toMatchObject({
        statusCode: 429,
        clientMessage: 'Bonus on cooldown',
        extra: {
          remainingSeconds: 90, // ceil((120000 - 30000) / 1000)
          nextAvailable: new Date(1_000_000 - 30_000 + CHAT_BONUS_COOLDOWN_MS).toISOString(),
        },
      });
      expect(accountService.addPoints).not.toHaveBeenCalled();
    });

    it('past cooldown is allowed even if a prior claim exists', async () => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
      const accountService = makeAccountStub({ balance: 1000 });
      const cooldowns = new Map([[42, 1_000_000 - CHAT_BONUS_COOLDOWN_MS - 1]]); // expired
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: cooldowns });

      await svc.claimChatBonus(42);
      expect(accountService.addPoints).toHaveBeenCalledTimes(1);
      expect(cooldowns.get(42)).toBe(1_000_000);
    });
  });

  describe('getBonusStatus', () => {
    let nowSpy;
    afterEach(() => nowSpy?.mockRestore());

    it('returns available: true when no prior claim', () => {
      const svc = new GameMechanicsService({
        accountService: makeAccountStub(),
        userBonusCooldowns: new Map(),
      });
      expect(svc.getBonusStatus(42)).toEqual({ available: true });
    });

    it('returns available: true when prior claim is past cooldown', () => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const cooldowns = new Map([[42, 1_000_000 - CHAT_BONUS_COOLDOWN_MS]]);
      const svc = new GameMechanicsService({
        accountService: makeAccountStub(),
        userBonusCooldowns: cooldowns,
      });
      expect(svc.getBonusStatus(42)).toEqual({ available: true });
    });

    it('returns available: false with remainingSeconds + nextAvailable inside cooldown', () => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const cooldowns = new Map([[42, 1_000_000 - 60_000]]); // claimed 60s ago
      const svc = new GameMechanicsService({
        accountService: makeAccountStub(),
        userBonusCooldowns: cooldowns,
      });

      expect(svc.getBonusStatus(42)).toEqual({
        available: false,
        remainingSeconds: 60, // ceil((120000 - 60000)/1000)
        nextAvailable: new Date(1_000_000 - 60_000 + CHAT_BONUS_COOLDOWN_MS).toISOString(),
      });
    });

    it('does not mutate the cooldown Map (read-only check)', () => {
      nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const cooldowns = new Map([[42, 999_000]]);
      const svc = new GameMechanicsService({
        accountService: makeAccountStub(),
        userBonusCooldowns: cooldowns,
      });
      svc.getBonusStatus(42);
      expect(cooldowns.get(42)).toBe(999_000);
      expect(cooldowns.size).toBe(1);
    });
  });

  describe('transferPoints', () => {
    it('happy path: debits sender, credits recipient, returns identifiers', async () => {
      const accountService = makeAccountStub({
        balance: 1000,
        user: { id: 42, username: 'sender' },
        targetUser: { id: 99, username: 'recipient' },
      });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      const result = await svc.transferPoints(42, 'recipient', 300, 'sender');

      expect(accountService.subtractPoints).toHaveBeenCalledWith(
        42, 300, 'transfer_out', 'Sent 300 points to recipient',
        { recipientId: 99, recipientUsername: 'recipient' }
      );
      expect(accountService.addPoints).toHaveBeenCalledWith(
        99, 300, 'transfer_in', 'Received 300 points from sender',
        { senderId: 42, senderUsername: 'sender' }
      );
      expect(result).toEqual({
        senderNewBalance: 700,
        recipientNewBalance: 1300, // stub adds to *its* balance state — assertion is shape-level
        recipientUserId: 99,
        recipientUsername: 'recipient',
      });
    });

    it('falls back to DB username when senderUsername arg is omitted', async () => {
      const accountService = makeAccountStub({
        balance: 1000,
        user: { id: 42, username: 'authoritative_name' },
        targetUser: { id: 99, username: 'recipient' },
      });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      await svc.transferPoints(42, 'recipient', 300);

      expect(accountService.addPoints).toHaveBeenCalledWith(
        99, 300, 'transfer_in', 'Received 300 points from authoritative_name',
        { senderId: 42, senderUsername: 'authoritative_name' }
      );
    });

    it('throws 404 when sender row is missing', async () => {
      const accountService = makeAccountStub({ userByIdOverride: null });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      await expect(svc.transferPoints(42, 'recipient', 300, 'sender')).rejects.toMatchObject({
        statusCode: 404,
        clientMessage: 'Sender not found',
      });
      expect(accountService.subtractPoints).not.toHaveBeenCalled();
    });

    it('throws 404 when recipient username does not resolve', async () => {
      const accountService = makeAccountStub({ userByUsernameOverride: null });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      await expect(svc.transferPoints(42, 'nope', 300, 'sender')).rejects.toMatchObject({
        statusCode: 404,
        clientMessage: "User 'nope' not found",
      });
      expect(accountService.subtractPoints).not.toHaveBeenCalled();
    });

    it('throws 400 when sender targets themselves (by username resolution)', async () => {
      const accountService = makeAccountStub({
        balance: 1000,
        user: { id: 42, username: 'sender' },
        targetUser: { id: 42, username: 'sender' }, // resolves to same id
      });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      await expect(svc.transferPoints(42, 'sender', 300, 'sender')).rejects.toMatchObject({
        statusCode: 400,
        clientMessage: 'Cannot send points to yourself',
      });
      expect(accountService.subtractPoints).not.toHaveBeenCalled();
    });

    it('throws 400 with balance + attempt in the message on insufficient funds', async () => {
      const accountService = makeAccountStub({ balance: 50 });
      const svc = new GameMechanicsService({ accountService, userBonusCooldowns: new Map() });

      await expect(svc.transferPoints(42, 'recipient', 300, 'sender')).rejects.toMatchObject({
        statusCode: 400,
        clientMessage: 'Insufficient points. You have 50 points but tried to send 300',
      });
      expect(accountService.subtractPoints).not.toHaveBeenCalled();
    });
  });

  describe('GameMechanicsError', () => {
    it('is an Error subclass with statusCode / clientMessage / extra', () => {
      const err = new GameMechanicsError(429, 'On cooldown', { remainingSeconds: 30 });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GameMechanicsError');
      expect(err.statusCode).toBe(429);
      expect(err.clientMessage).toBe('On cooldown');
      expect(err.extra).toEqual({ remainingSeconds: 30 });
      expect(err.message).toBe('On cooldown');
    });

    it('defaults extra to an empty object', () => {
      const err = new GameMechanicsError(400, 'Bad input');
      expect(err.extra).toEqual({});
    });
  });
});
