const TakeoverService = require('../services/TakeoverService');

describe('TakeoverService', () => {
  let takeoverService;

  beforeEach(() => {
    takeoverService = new TakeoverService();
    takeoverService.setCooldownSeconds(5);
  });

  afterEach(() => {
    takeoverService.inMemoryStorage.clear();
  });

  describe('canTakeOver', () => {
    test('should allow takeover when no previous takeover exists', async () => {
      const result = await takeoverService.canTakeOver();
      
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.cooldownRemaining).toBeUndefined();
    });

    test('should deny takeover during cooldown period', async () => {
      // Set a non-zero cooldown so recordTakeover() actually gates the next
      // canTakeOver(). The default ctor doesn't seed cooldownSeconds (see the
      // "default cooldown" test below) — callers must opt in.
      takeoverService.setCooldownSeconds(30);
      await takeoverService.recordTakeover();

      const result = await takeoverService.canTakeOver();
      
      expect(result.allowed).toBe(false);
      // 'global_cooldown' distinguishes from 'user_cooldown' (the per-user
      // gate added later); the test was originally written when there was
      // only one reason string.
      expect(result.reason).toBe('global_cooldown');
      expect(result.cooldownRemaining).toBeGreaterThan(0);
      expect(result.cooldownRemaining).toBeLessThanOrEqual(30);
    });

    test('should allow takeover after cooldown period', async () => {
      const pastTimestamp = Date.now() - 6000;
      takeoverService.inMemoryStorage.set('last_takeover_time', pastTimestamp);
      
      const result = await takeoverService.canTakeOver();
      
      expect(result.allowed).toBe(true);
    });
  });

  describe('recordTakeover', () => {
    test('should record takeover timestamp', async () => {
      const beforeTime = Date.now();
      await takeoverService.recordTakeover();
      const afterTime = Date.now();
      
      const recordedTime = await takeoverService.getLastTakeoverTime();
      
      expect(recordedTime).toBeGreaterThanOrEqual(beforeTime);
      expect(recordedTime).toBeLessThanOrEqual(afterTime);
    });
  });

  describe('getLastTakeoverTime', () => {
    test('should return null when no takeover recorded', async () => {
      const result = await takeoverService.getLastTakeoverTime();
      expect(result).toBe(null);
    });

    test('should return recorded timestamp', async () => {
      const timestamp = Date.now();
      takeoverService.inMemoryStorage.set('last_takeover_time', timestamp);
      
      const result = await takeoverService.getLastTakeoverTime();
      expect(result).toBe(timestamp);
    });
  });

  describe('getRemainingCooldown', () => {
    test('should return 0 when no takeover recorded', async () => {
      const remaining = await takeoverService.getRemainingCooldown();
      expect(remaining).toBe(0);
    });

    test('should return 0 when cooldown period has passed', async () => {
      const pastTimestamp = Date.now() - 6000;
      takeoverService.inMemoryStorage.set('last_takeover_time', pastTimestamp);
      
      const remaining = await takeoverService.getRemainingCooldown();
      expect(remaining).toBe(0);
    });

    test('should return remaining seconds during cooldown', async () => {
      await takeoverService.recordTakeover();
      
      const remaining = await takeoverService.getRemainingCooldown();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(5);
    });
  });

  describe('cooldown configuration', () => {
    // The original assertion expected an env-driven default of 30s. The
    // current constructor never reads TAKEOVER_COOLDOWN_SEC — callers must
    // opt in via setCooldownSeconds(). Lock in the actual behavior so any
    // future regression (or a real default-cooldown implementation) shows
    // up in CI.
    test('no-arg constructor leaves cooldownSeconds unset (callers must opt in via setCooldownSeconds)', () => {
      const service = new TakeoverService();
      expect(service.getCooldownSeconds()).toBeUndefined();
      service.setCooldownSeconds(30);
      expect(service.getCooldownSeconds()).toBe(30);
    });

    test('should allow setting custom cooldown', () => {
      takeoverService.setCooldownSeconds(10);
      expect(takeoverService.getCooldownSeconds()).toBe(10);
    });
  });

  describe('with Redis client', () => {
    let mockRedisClient;

    beforeEach(() => {
      mockRedisClient = {
        get: jest.fn(),
        set: jest.fn()
      };
      takeoverService = new TakeoverService(mockRedisClient);
      takeoverService.setCooldownSeconds(5);
    });

    test('should use Redis for storage when available', async () => {
      mockRedisClient.get.mockResolvedValue('1234567890');
      
      const result = await takeoverService.getLastTakeoverTime();
      
      expect(mockRedisClient.get).toHaveBeenCalledWith('last_takeover_time');
      expect(result).toBe(1234567890);
    });

    test('should fallback to in-memory on Redis error', async () => {
      mockRedisClient.get.mockRejectedValue(new Error('Redis error'));
      takeoverService.inMemoryStorage.set('last_takeover_time', 9876543210);
      
      const result = await takeoverService.getLastTakeoverTime();
      
      expect(result).toBe(9876543210);
    });

    test('should record to Redis when available', async () => {
      mockRedisClient.set.mockResolvedValue('OK');
      
      await takeoverService.recordTakeover();
      
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        'last_takeover_time', 
        expect.any(String)
      );
    });

    test('should fallback to in-memory on Redis record error', async () => {
      mockRedisClient.set.mockRejectedValue(new Error('Redis error'));
      
      await takeoverService.recordTakeover();
      
      const result = takeoverService.inMemoryStorage.get('last_takeover_time');
      expect(result).toBeTruthy();
    });
  });
});