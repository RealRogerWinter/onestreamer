// Unit tests for PlatformSelector (PR 17.1).
// Targets: isReady() decision matrix, weighted random selection, single-platform
// shortcut, interval bounds.

const PlatformSelector = require('../../../services/random-stream/PlatformSelector');

const makeTwitch = (configured) => ({ isConfigured: () => configured });
const makeKick = () => ({});

describe('PlatformSelector', () => {
  describe('isReady()', () => {
    test('returns ready when twitch enabled+configured and a viewBotURLService is supplied', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const result = sel.isReady({ platforms: ['twitch'] }, /* viewBotURLService */ {});
      expect(result).toEqual({ ready: true, availablePlatforms: ['twitch'] });
    });

    test('returns ready when kick enabled (no API config needed) and viewBotURLService is supplied', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(false), kickService: makeKick() });
      const result = sel.isReady({ platforms: ['kick'] }, {});
      expect(result).toEqual({ ready: true, availablePlatforms: ['kick'] });
    });

    test('error: Twitch unconfigured AND Kick not enabled', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(false), kickService: makeKick() });
      const result = sel.isReady({ platforms: ['twitch'] }, {});
      expect(result.ready).toBe(false);
      expect(result.error).toMatch(/Twitch API not configured/);
    });

    test('error: empty platforms array', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const result = sel.isReady({ platforms: [] }, {});
      expect(result.ready).toBe(false);
      expect(result.error).toMatch(/No platforms enabled/);
    });

    test('error: viewBotURLService missing even when platforms are good', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const result = sel.isReady({ platforms: ['twitch', 'kick'] }, null);
      expect(result.ready).toBe(false);
      expect(result.error).toMatch(/ViewBotURLService not set/);
    });

    test('falls back to ["twitch"] when settings.platforms is undefined', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const result = sel.isReady({}, {});
      expect(result.ready).toBe(true);
      expect(result.availablePlatforms).toEqual(['twitch']);
    });
  });

  describe('selectRandom()', () => {
    test('returns null when no platforms are available', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(false), kickService: makeKick() });
      expect(sel.selectRandom({ platforms: ['twitch'] })).toBeNull();
    });

    test('returns the only available platform without rolling RNG when only one is available', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(false), kickService: makeKick() });
      const rand = jest.spyOn(Math, 'random').mockReturnValue(0.999);
      try {
        expect(sel.selectRandom({ platforms: ['twitch', 'kick'] })).toBe('kick');
      } finally {
        rand.mockRestore();
      }
    });

    test('heavily-twitch weights (99/1): twitch dominates', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { platforms: ['twitch', 'kick'], platformWeight: { twitch: 99, kick: 1 } };
      const counts = { twitch: 0, kick: 0 };
      for (let i = 0; i < 1000; i++) counts[sel.selectRandom(settings)]++;
      expect(counts.twitch).toBeGreaterThan(900);
    });

    test('heavily-kick weights (1/99): kick dominates', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { platforms: ['twitch', 'kick'], platformWeight: { twitch: 1, kick: 99 } };
      const counts = { twitch: 0, kick: 0 };
      for (let i = 0; i < 1000; i++) counts[sel.selectRandom(settings)]++;
      expect(counts.kick).toBeGreaterThan(900);
    });

    test('deterministic weighted pick via stubbed Math.random — early roll lands on twitch', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { platforms: ['twitch', 'kick'], platformWeight: { twitch: 70, kick: 30 } };
      const rand = jest.spyOn(Math, 'random').mockReturnValue(0.1); // 0.1 × 100 = 10 ≤ 70 → twitch
      try {
        expect(sel.selectRandom(settings)).toBe('twitch');
      } finally {
        rand.mockRestore();
      }
    });

    test('deterministic weighted pick via stubbed Math.random — late roll lands on kick', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { platforms: ['twitch', 'kick'], platformWeight: { twitch: 70, kick: 30 } };
      const rand = jest.spyOn(Math, 'random').mockReturnValue(0.9); // 0.9 × 100 = 90 → past twitch (70), into kick
      try {
        expect(sel.selectRandom(settings)).toBe('kick');
      } finally {
        rand.mockRestore();
      }
    });

    test('50/50 weights produce a mix across many rolls', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { platforms: ['twitch', 'kick'], platformWeight: { twitch: 50, kick: 50 } };
      const counts = { twitch: 0, kick: 0 };
      for (let i = 0; i < 1000; i++) counts[sel.selectRandom(settings)]++;
      expect(counts.twitch).toBeGreaterThan(300);
      expect(counts.kick).toBeGreaterThan(300);
      expect(counts.twitch + counts.kick).toBe(1000);
    });

    test('defaults to 50/50 weights when platformWeight is not provided', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { platforms: ['twitch', 'kick'] };
      const counts = { twitch: 0, kick: 0 };
      for (let i = 0; i < 500; i++) counts[sel.selectRandom(settings)]++;
      expect(counts.twitch).toBeGreaterThan(100);
      expect(counts.kick).toBeGreaterThan(100);
    });
  });

  describe('getRandomInterval()', () => {
    test('returns an interval within [min, max] in ms', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { minRotationMinutes: 1, maxRotationMinutes: 11 };
      const min = 1 * 60 * 1000;
      const max = 11 * 60 * 1000;
      for (let i = 0; i < 100; i++) {
        const v = sel.getRandomInterval(settings);
        expect(v).toBeGreaterThanOrEqual(min);
        expect(v).toBeLessThanOrEqual(max);
      }
    });

    test('when min===max, always returns that exact value', () => {
      const sel = new PlatformSelector({ twitchService: makeTwitch(true), kickService: makeKick() });
      const settings = { minRotationMinutes: 5, maxRotationMinutes: 5 };
      for (let i = 0; i < 20; i++) {
        expect(sel.getRandomInterval(settings)).toBe(5 * 60 * 1000);
      }
    });
  });
});
