const {
  buildCombinedPrompt,
  temporaryBotExpiresAt,
  deleteTemporaryBotRecords,
  quiesceBotInstance,
} = require('../../../services/chatbot/temporaryBotLifecycle');

describe('buildCombinedPrompt', () => {
  test('composes movie prompt + personality + name', () => {
    expect(buildCombinedPrompt('MOVIE', 'snarky', 'Rex')).toBe(
      'MOVIE\n\nYour specific personality: snarky\nYour name is Rex.'
    );
  });
});

describe('temporaryBotExpiresAt', () => {
  test('returns now + duration seconds as a Date', () => {
    const now = 1_000_000;
    expect(temporaryBotExpiresAt(100, now).toISOString()).toBe(new Date(now + 100_000).toISOString());
  });
});

describe('deleteTemporaryBotRecords', () => {
  test('calls the three deletes in FK-safe order with the chosen final delete', async () => {
    const order = [];
    const repo = {
      deleteAutoSummonedForBot: jest.fn(() => { order.push('auto'); }),
      deleteTemporaryRecord: jest.fn(() => { order.push('temp'); }),
      deleteTemporaryById: jest.fn(() => { order.push('tempById'); }),
      deleteById: jest.fn(() => { order.push('byId'); }),
    };
    await deleteTemporaryBotRecords(repo, 7, 'deleteTemporaryById');
    expect(order).toEqual(['auto', 'temp', 'tempById']);
    expect(repo.deleteById).not.toHaveBeenCalled();
    expect(repo.deleteAutoSummonedForBot).toHaveBeenCalledWith(7);
  });
});

describe('quiesceBotInstance', () => {
  test('clears the response timer, disables, and disconnects', () => {
    const cleared = [];
    const realClear = global.clearTimeout;
    global.clearTimeout = jest.fn((h) => cleared.push(h));
    try {
      const inst = { responseTimer: 123, data: { is_enabled: 1 }, connected: true };
      quiesceBotInstance(inst);
      expect(cleared).toEqual([123]);
      expect(inst.responseTimer).toBeNull();
      expect(inst.data.is_enabled).toBe(0);
      expect(inst.connected).toBe(false);
    } finally {
      global.clearTimeout = realClear;
    }
  });

  test('no-ops on a null instance', () => {
    expect(() => quiesceBotInstance(null)).not.toThrow();
  });

  test('handles an instance with no active timer', () => {
    const inst = { responseTimer: null, data: { is_enabled: 1 }, connected: true };
    quiesceBotInstance(inst);
    expect(inst.data.is_enabled).toBe(0);
    expect(inst.connected).toBe(false);
  });
});
