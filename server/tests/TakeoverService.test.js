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

  describe('concurrent claims and cooldown lifecycle', () => {
    // The existing 8 tests cover sequential happy paths. This block targets
    // the gaps named in docs/architecture/background-work.md / refactor plan
    // PR 2.2: what does TakeoverService do when two users race to claim, when
    // cooldowns are read concurrently, and at the elapsed-time boundary?
    // These tests are the safety net before Phase 3's state-unification work
    // touches the same hot paths.

    beforeEach(() => {
      // canTakeOver() reads globalCooldownSeconds / individualCooldownSeconds
      // (env-driven, defaults 30 / 60). setCooldownSeconds() targets a
      // legacy field that canTakeOver ignores, so set the live properties
      // directly for deterministic test windows.
      takeoverService.globalCooldownSeconds = 30;
      takeoverService.individualCooldownSeconds = 60;
    });

    test('two simultaneous canTakeOver() before any recordTakeover both return allowed=true (service does not reserve)', async () => {
      // The classic check-then-act race: two users hit /request-to-stream
      // at the same time. TakeoverService inspects state and returns; it
      // does not hold a lock. With no global or per-IP cooldown active,
      // both racing claimants are told "allowed". Serialization between the
      // allow decision and the recordTakeover write must happen at the
      // caller layer (server/sockets/StreamHandler.js). PR 2.5 hardens the
      // broader stream-status ordering with a monotonic streamGeneration
      // counter on emits — this test pins down that TakeoverService itself
      // is intentionally non-reserving so a future refactor doesn't
      // silently start serializing here (which would mask the caller-layer
      // gap PR 2.5 actually fixes).
      const [alice, bob] = await Promise.all([
        takeoverService.canTakeOver('socket-alice'),
        takeoverService.canTakeOver('socket-bob'),
      ]);

      expect(alice.allowed).toBe(true);
      expect(bob.allowed).toBe(true);
    });

    test('after recordTakeover, concurrent canTakeOver calls all return denied with global_cooldown', async () => {
      // The complement to the previous test. Once recordTakeover has set
      // lastStreamStartTime, every subsequent reader sees it. Proves there
      // is no stale-read window inside canTakeOver — if someone refactors
      // recordTakeover to defer the in-memory write past an await (e.g.,
      // for Redis ack), this test fails.
      await takeoverService.recordTakeover();

      const results = await Promise.all([
        takeoverService.canTakeOver('socket-late-1'),
        takeoverService.canTakeOver('socket-late-2'),
        takeoverService.canTakeOver('socket-late-3'),
      ]);

      for (const result of results) {
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('global_cooldown');
        expect(result.cooldownRemaining).toBeGreaterThan(0);
        expect(result.cooldownRemaining).toBeLessThanOrEqual(30);
      }
    });

    test('per-identifier cooldown on one socket does not block another socket', async () => {
      // Multi-user isolation: Alice losing the stream and getting a
      // stream_taken_over cooldown must not prevent Bob from claiming.
      // With no sessionService wired, socketId IS the cooldown identifier
      // — the same code path the IP-identifier branch hits in production.
      await takeoverService.setIpCooldown('alice-socket', 'stream_taken_over');

      const bob = await takeoverService.canTakeOver('bob-socket');
      expect(bob.allowed).toBe(true);

      const alice = await takeoverService.canTakeOver('alice-socket');
      expect(alice.allowed).toBe(false);
      expect(alice.reason).toBe('individual_cooldown');
      expect(alice.cooldownRemaining).toBeGreaterThan(0);
      expect(alice.cooldownRemaining).toBeLessThanOrEqual(60);
    });

    test('global cooldown allows again once lastStreamStartTime is older than the window', async () => {
      // Boundary test. Mutate lastStreamStartTime to simulate elapsed time
      // without burning real wall-clock seconds. Catches off-by-one in the
      // (now - lastStreamStartTime) < cooldownMs comparison and any future
      // refactor that swaps to e.g. <= or uses a different time source.
      takeoverService.lastStreamStartTime = Date.now() - 5000; // inside 30s window
      const blocked = await takeoverService.canTakeOver('socket-A');
      expect(blocked.allowed).toBe(false);
      expect(blocked.reason).toBe('global_cooldown');

      takeoverService.lastStreamStartTime = Date.now() - 31000; // outside 30s window
      const allowed = await takeoverService.canTakeOver('socket-A');
      expect(allowed.allowed).toBe(true);
    });
  });
});