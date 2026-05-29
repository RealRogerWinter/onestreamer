const BotCooldownTracker = require('../../../services/viewbot/BotCooldownTracker');

const WINDOW = 2 * 60 * 60 * 1000; // 2h, matching the service config

function tracker() {
  return new BotCooldownTracker({ windowMs: WINDOW, decayFactor: 0.5, minProbability: 0.1 });
}

describe('BotCooldownTracker', () => {
  test('unknown bot has full weight (1.0)', () => {
    expect(tracker().getMultiplier('bot-A', 0)).toBe(1.0);
  });

  test('weight halves per play within the window', () => {
    const t = tracker();
    t.record('bot-A', 0);
    expect(t.getMultiplier('bot-A', 1000)).toBe(0.5); // 0.5^1
    t.record('bot-A', 2000);
    expect(t.getMultiplier('bot-A', 3000)).toBe(0.25); // 0.5^2
    t.record('bot-A', 4000);
    expect(t.getMultiplier('bot-A', 5000)).toBeCloseTo(0.125); // 0.5^3
  });

  test('weight is floored at minProbability', () => {
    const t = tracker();
    for (let i = 0; i < 10; i++) t.record('bot-A', i); // 0.5^10 << 0.1
    expect(t.getMultiplier('bot-A', 10)).toBe(0.1);
  });

  test('a play outside the window resets the count to 1', () => {
    const t = tracker();
    t.record('bot-A', 0);
    t.record('bot-A', WINDOW + 1); // outside window -> reset
    expect(t.getMultiplier('bot-A', WINDOW + 2)).toBe(0.5); // back to 0.5^1
  });

  test('getMultiplier drops an expired entry and returns 1.0', () => {
    const t = tracker();
    t.record('bot-A', 0);
    expect(t.getMultiplier('bot-A', WINDOW + 1)).toBe(1.0);
    // entry was deleted -> still 1.0, and sweep finds nothing
    expect(t.sweepExpired(WINDOW + 2)).toEqual([]);
  });

  test('sweepExpired removes only entries past the window', () => {
    const t = tracker();
    t.record('old', 0);
    t.record('fresh', WINDOW); // lastPlayed at WINDOW
    const removed = t.sweepExpired(WINDOW + 1); // old: WINDOW+1 elapsed (>WINDOW); fresh: 1ms
    expect(removed).toEqual(['old']);
    expect(t.getMultiplier('fresh', WINDOW + 1)).toBe(0.5);
  });
});
