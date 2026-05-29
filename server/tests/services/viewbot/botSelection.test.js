const { selectWeightedBot } = require('../../../services/viewbot/botSelection');

const equalWeight = () => 1.0;

describe('selectWeightedBot', () => {
  test('returns null for an empty list', () => {
    expect(selectWeightedBot([], equalWeight)).toBeNull();
  });

  test('returns the sole bot without consulting weights/rng', () => {
    const getWeight = jest.fn(() => 1);
    const rng = jest.fn(() => 0.99);
    const only = { botId: 'bot-A' };
    expect(selectWeightedBot([only], getWeight, { rng })).toBe(only);
    expect(getWeight).not.toHaveBeenCalled();
    expect(rng).not.toHaveBeenCalled();
  });

  test('selects by cumulative weight using the injected rng', () => {
    const bots = [{ botId: 'bot-A' }, { botId: 'bot-B' }, { botId: 'bot-C' }];
    const getWeight = () => 1; // total weight 3, each spans 1.0 of the line
    // rng() * total picks the point on the [0,3) line.
    expect(selectWeightedBot(bots, getWeight, { rng: () => 0.0 }).botId).toBe('bot-A'); // 0 -> A
    expect(selectWeightedBot(bots, getWeight, { rng: () => 0.5 }).botId).toBe('bot-B'); // 1.5 -> B
    expect(selectWeightedBot(bots, getWeight, { rng: () => 0.9 }).botId).toBe('bot-C'); // 2.7 -> C
  });

  test('respects unequal weights (heavier bot owns more of the line)', () => {
    const bots = [{ botId: 'light' }, { botId: 'heavy' }];
    const getWeight = (id) => (id === 'heavy' ? 9 : 1); // total 10: light=[0,1), heavy=[1,10)
    expect(selectWeightedBot(bots, getWeight, { rng: () => 0.05 }).botId).toBe('light'); // 0.5
    expect(selectWeightedBot(bots, getWeight, { rng: () => 0.2 }).botId).toBe('heavy'); // 2.0
  });

  test('rng at the top edge selects the last bot (cumulative boundary)', () => {
    const bots = [{ botId: 'bot-A' }, { botId: 'bot-B' }];
    // rng() === 1 -> random = total (2); subtracting both weights lands exactly
    // at 0 on the last bot (0 <= 0), so it is returned. The `return
    // availableBots[0]` line is an unreachable safety fallback (preserved as-is).
    expect(selectWeightedBot(bots, () => 1, { rng: () => 1 }).botId).toBe('bot-B');
  });
});
