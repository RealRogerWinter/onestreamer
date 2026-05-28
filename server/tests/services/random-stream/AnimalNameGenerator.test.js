// Unit tests for AnimalNameGenerator (PR 17.1).
// Targets: name shape, uniqueness via the usedNames Set, the 100-attempt
// fallback that clears the cache when the namespace exhausts, reset().

const AnimalNameGenerator = require('../../../services/random-stream/AnimalNameGenerator');
const { ANIMALS, ADJECTIVES } = AnimalNameGenerator;

describe('AnimalNameGenerator', () => {
  describe('canonical word lists', () => {
    test('ANIMALS export is non-trivial', () => {
      expect(Array.isArray(ANIMALS)).toBe(true);
      expect(ANIMALS.length).toBeGreaterThan(100);
    });

    test('ADJECTIVES export is non-trivial', () => {
      expect(Array.isArray(ADJECTIVES)).toBe(true);
      expect(ADJECTIVES.length).toBeGreaterThan(20);
    });
  });

  describe('generate()', () => {
    test('produces "Adjective Animal" pairs from the supplied lists', () => {
      const gen = new AnimalNameGenerator({ animals: ['Wolf', 'Fox'], adjectives: ['Swift', 'Silent'] });
      const name = gen.generate();
      const [adj, ...rest] = name.split(' ');
      const animal = rest.join(' ');
      expect(['Swift', 'Silent']).toContain(adj);
      expect(['Wolf', 'Fox']).toContain(animal);
    });

    test('with one adjective × one animal: always the same name; usedNames clears after maxAttempts', () => {
      const gen = new AnimalNameGenerator({
        animals: ['Cat'],
        adjectives: ['Lucky'],
        maxAttempts: 5,
      });
      const first = gen.generate();
      expect(first).toBe('Lucky Cat');
      expect(gen.usedNames.size).toBe(1);

      // Second call: only one possible name exists; loop hits maxAttempts and clears,
      // then re-adds. usedNames should end as {first} again, not grow unboundedly.
      const second = gen.generate();
      expect(second).toBe('Lucky Cat');
      expect(gen.usedNames.size).toBe(1);
    });

    test('does not repeat across many calls when the cartesian product is large', () => {
      const gen = new AnimalNameGenerator();
      const names = new Set();
      for (let i = 0; i < 50; i++) names.add(gen.generate());
      // 50 calls into a 160×40 = 6400 namespace — collisions are statistically
      // very rare and the dedup loop guarantees uniqueness until the 100-attempt
      // fallback kicks in (which can't happen in 50 calls).
      expect(names.size).toBe(50);
    });

    test('logger.debug fires when the cache-clear fallback is triggered', () => {
      const debug = jest.fn();
      const gen = new AnimalNameGenerator({
        animals: ['Cat'],
        adjectives: ['Lucky'],
        maxAttempts: 3,
        logger: { debug },
      });
      gen.generate(); // first add — no fallback
      expect(debug).not.toHaveBeenCalled();
      gen.generate(); // triggers maxAttempts fallback
      expect(debug).toHaveBeenCalled();
    });
  });

  describe('reset()', () => {
    test('clears the used-names cache', () => {
      const gen = new AnimalNameGenerator();
      gen.generate();
      gen.generate();
      expect(gen.usedNames.size).toBeGreaterThan(0);
      gen.reset();
      expect(gen.usedNames.size).toBe(0);
    });
  });
});
