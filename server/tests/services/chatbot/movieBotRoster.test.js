const { filterActiveMovieBots } = require('../../../services/chatbot/movieBotRoster');

const NOW = new Date('2026-01-01T00:00:00Z');
const past = new Date(NOW.getTime() - 1000).toISOString();
const future = new Date(NOW.getTime() + 60_000).toISOString();

function instances(...connectedIds) {
  const m = new Map();
  for (const id of connectedIds) m.set(id, { connected: true, username: `${id}_user` });
  return m;
}

describe('filterActiveMovieBots', () => {
  test('keeps only connected bots, mapped to {id,username,name,model}', () => {
    const repoBots = [
      { id: 'b1', name: 'Alpha', llm_model: 'llama', is_temporary: 0 },
      { id: 'b2', name: 'Beta', llm_model: 'gpt', is_temporary: 0 }, // not connected
    ];
    expect(filterActiveMovieBots(repoBots, instances('b1'), NOW)).toEqual([
      { id: 'b1', username: 'b1_user', name: 'Alpha', model: 'llama' },
    ]);
  });

  test('drops a disconnected instance even if present in the map', () => {
    const map = new Map([['b1', { connected: false, username: 'b1_user' }]]);
    const repoBots = [{ id: 'b1', name: 'A', llm_model: 'm', is_temporary: 0 }];
    expect(filterActiveMovieBots(repoBots, map, NOW)).toEqual([]);
  });

  test('excludes expired temporary bots, keeps unexpired and non-temporary', () => {
    const repoBots = [
      { id: 'exp', name: 'Expired', llm_model: 'm', is_temporary: 1, expires_at: past },
      { id: 'liv', name: 'Live', llm_model: 'm', is_temporary: 1, expires_at: future },
      { id: 'perm', name: 'Perm', llm_model: 'm', is_temporary: 0, expires_at: null },
    ];
    const result = filterActiveMovieBots(repoBots, instances('exp', 'liv', 'perm'), NOW);
    expect(result.map(b => b.id)).toEqual(['liv', 'perm']);
  });

  test('logs once per skipped expired bot when a logger is supplied', () => {
    const logger = { debug: jest.fn() };
    const repoBots = [{ id: 'exp', name: 'Expired', llm_model: 'm', is_temporary: 1, expires_at: past }];
    filterActiveMovieBots(repoBots, instances('exp'), NOW, logger);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0][0]).toContain('Skipping expired bot exp');
  });
});
