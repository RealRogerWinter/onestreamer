// Characterization net for BuffDebuffService (PR: refactor/buffdebuffservice-decompose).
//
// Pins the externally-observable behaviour BEFORE the service is decomposed
// into collaborators under server/services/buffdebuff/. The service is an
// EventEmitter consumed by VisualFxService (`buffDebuffService.on('buff-applied')`
// / `'buff-expired'`), so these tests attach real listeners and assert the
// service instance itself emits the expected events with the expected payloads.
//
// What's pinned:
//   - applyBuff: looks up item, creates a buff, tracks it in cache, emits
//     'buff-applied' with the stream_id-tagged payload, mirrors to io.
//   - stacking behaviour: replace removes the old buff, extend bumps remaining,
//     stack creates a second instance.
//   - removeBuff: marks inactive, drops from cache, emits 'buff-expired'.
//   - anonymous (negative userId) path: in-memory buffs, synthetic ids,
//     emits the same events.
//   - getActiveBuffsForUser / formatBuffForClient shape.
//   - cleanupExpiredBuffs delegates removeBuff per expired row.
//   - shutdown clears the interval timers.
//
// Construction kicks off async initialize() (fire-and-forget) which starts two
// setInterval timers. We use fake timers so nothing fires during a test, and
// shutdown() in afterEach clears them.

jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

// Avoid dragging the SQLite adapter into the require graph. The service
// late-binds these via the injected repositories, so the singleton export is
// only touched if a repo is NOT injected — we always inject below.
jest.mock('../../database/database', () => ({
  runAsync: jest.fn(),
  getAsync: jest.fn(),
  allAsync: jest.fn(),
}));
// Default repo constructors must not touch real DB. We inject doubles, but the
// constructor still `new`s the default class when a repo arg is omitted.
jest.mock('../../database/repository/ItemRepository', () => class {});
jest.mock('../../database/repository/BuffRepository', () => class {});

const BuffDebuffService = require('../../services/BuffDebuffService');

function makeItemRepo({ items = [] } = {}) {
  return {
    getById: jest.fn().mockImplementation((id) =>
      Promise.resolve(items.find((x) => x.id === id) || null)),
    getByIdIncludingInactive: jest.fn().mockImplementation((id) =>
      Promise.resolve(items.find((x) => x.id === id) || null)),
  };
}

function makeBuffRepo() {
  let nextId = 100;
  const rows = new Map();
  const repo = {
    _rows: rows,
    insertBuff: jest.fn().mockImplementation(({ userId, itemId, appliedByUserId, buffType, duration, metadata }) => {
      const id = nextId++;
      rows.set(id, {
        id, user_id: userId, item_id: itemId, applied_by_user_id: appliedByUserId,
        buff_type: buffType, duration_seconds: duration, remaining_seconds: duration,
        is_active: 1, applied_at: new Date().toISOString(), metadata: metadata || null,
        streaming_time_used: 0,
      });
      return Promise.resolve({ id, changes: 1 });
    }),
    getById: jest.fn().mockImplementation((id) => Promise.resolve(rows.get(id) || null)),
    getByIdWithItem: jest.fn().mockImplementation((id) => {
      const r = rows.get(id);
      if (!r) return Promise.resolve(null);
      return Promise.resolve({ ...r, item_name: 'thing', display_name: 'Thing', emoji: '✨', effect_data: null });
    }),
    updateRemainingSeconds: jest.fn().mockImplementation((id, secs) => {
      const r = rows.get(id);
      if (r) r.remaining_seconds = secs;
      return Promise.resolve({ changes: 1 });
    }),
    markInactive: jest.fn().mockImplementation((id) => {
      const r = rows.get(id);
      if (r) { r.is_active = 0; r.remaining_seconds = 0; }
      return Promise.resolve({ changes: 1 });
    }),
    incrementStreamingTime: jest.fn().mockResolvedValue({ changes: 1 }),
    listActiveWithItems: jest.fn().mockResolvedValue([]),
    listActiveWithItemsOrdered: jest.fn().mockResolvedValue([]),
    listActiveForUser: jest.fn().mockImplementation((userId) =>
      Promise.resolve(Array.from(rows.values())
        .filter((r) => r.user_id === userId && r.is_active && r.remaining_seconds > 0)
        .map((r) => ({ ...r, item_name: 'thing', display_name: 'Thing', emoji: '✨', effect_data: null })))),
    getActiveByUserAndItem: jest.fn().mockImplementation((userId, itemId) =>
      Promise.resolve(Array.from(rows.values())
        .find((r) => r.user_id === userId && r.item_id === itemId && r.is_active && r.remaining_seconds > 0) || null)),
    findExpired: jest.fn().mockResolvedValue([]),
    getStatsLast7Days: jest.fn().mockResolvedValue([]),
  };
  return repo;
}

function makeService(overrides = {}) {
  const itemRepository = overrides.itemRepository || makeItemRepo();
  const buffRepository = overrides.buffRepository || makeBuffRepo();
  const io = overrides.io === undefined ? null : overrides.io;
  const svc = new BuffDebuffService(
    io,
    overrides.streamService || null,
    overrides.timeTrackingService || null,
    overrides.sessionService || null,
    { itemRepository, buffRepository, buffNotifier: overrides.buffNotifier || null }
  );
  return { svc, itemRepository, buffRepository };
}

const BUFF_ITEM = {
  id: 1, name: 'speed', display_name: 'Speed', emoji: '⚡',
  item_type: 'buff', duration_seconds: 60, stack_behavior: 'replace',
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('BuffDebuffService characterization', () => {
  test('is an EventEmitter (VisualFxService contract)', () => {
    const { svc } = makeService();
    expect(typeof svc.on).toBe('function');
    expect(typeof svc.emit).toBe('function');
    expect(typeof svc.listenerCount).toBe('function');
    svc.shutdown();
  });

  test('applyBuff creates a buff, tracks it in cache, and emits buff-applied', async () => {
    const { svc } = makeService({ itemRepository: makeItemRepo({ items: [BUFF_ITEM] }) });
    const applied = [];
    svc.on('buff-applied', (e) => applied.push(e));

    const buff = await svc.applyBuff(5, 1, 9, 30, null, true, 'stream-A');

    expect(buff).toBeTruthy();
    expect(buff.user_id).toBe(5);
    expect(buff.item_id).toBe(1);
    // tracked in the active-buffs cache
    expect(svc.activeBuffsCache.has(buff.id)).toBe(true);
    // emitted exactly once with the stream_id-tagged payload
    expect(applied).toHaveLength(1);
    expect(applied[0].id).toBe(buff.id);
    expect(applied[0].stream_id).toBe('stream-A');
    svc.shutdown();
  });

  test('applyBuff uses item duration_seconds when duration omitted', async () => {
    const { svc, buffRepository } = makeService({ itemRepository: makeItemRepo({ items: [BUFF_ITEM] }) });
    await svc.applyBuff(5, 1, 9, null, null, true, null);
    expect(buffRepository.insertBuff).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 60 })
    );
    svc.shutdown();
  });

  test('applyBuff throws when item is missing', async () => {
    const { svc } = makeService({ itemRepository: makeItemRepo({ items: [] }) });
    await expect(svc.applyBuff(5, 999, 9, 30, null, true, null)).rejects.toThrow('Item not found');
    svc.shutdown();
  });

  test('applyBuff throws when item is not a buff/debuff', async () => {
    const consumable = { id: 2, name: 'apple', display_name: 'Apple', item_type: 'consumable', stack_behavior: 'replace' };
    const { svc } = makeService({ itemRepository: makeItemRepo({ items: [consumable] }) });
    await expect(svc.applyBuff(5, 2, 9, 30, null, true, null)).rejects.toThrow('not a buff or debuff');
    svc.shutdown();
  });

  test('stack_behavior=replace removes the prior buff before creating the new one', async () => {
    const { svc } = makeService({ itemRepository: makeItemRepo({ items: [BUFF_ITEM] }) });
    const removeSpy = jest.spyOn(svc, 'removeBuff');
    const first = await svc.applyBuff(5, 1, 9, 30, null, true, null);
    const second = await svc.applyBuff(5, 1, 9, 30, null, true, null);
    expect(removeSpy).toHaveBeenCalledWith(first.id);
    expect(second.id).not.toBe(first.id);
    svc.shutdown();
  });

  test('stack_behavior=extend bumps the remaining time of the existing buff', async () => {
    const extendItem = { ...BUFF_ITEM, stack_behavior: 'extend' };
    const { svc, buffRepository } = makeService({ itemRepository: makeItemRepo({ items: [extendItem] }) });
    const first = await svc.applyBuff(5, 1, 9, 30, null, true, null);
    const updateSpy = jest.spyOn(buffRepository, 'updateRemainingSeconds');
    const second = await svc.applyBuff(5, 1, 9, 30, null, true, null);
    // same buff id, remaining extended (30 existing + 30 new)
    expect(second.id).toBe(first.id);
    expect(updateSpy).toHaveBeenCalledWith(first.id, 60);
    svc.shutdown();
  });

  test('stack_behavior=stack creates a second separate buff', async () => {
    const stackItem = { ...BUFF_ITEM, stack_behavior: 'stack' };
    const { svc } = makeService({ itemRepository: makeItemRepo({ items: [stackItem] }) });
    const first = await svc.applyBuff(5, 1, 9, 30, null, true, null);
    const second = await svc.applyBuff(5, 1, 9, 30, null, true, null);
    expect(second.id).not.toBe(first.id);
    expect(svc.activeBuffsCache.has(first.id)).toBe(true);
    expect(svc.activeBuffsCache.has(second.id)).toBe(true);
    svc.shutdown();
  });

  test('removeBuff marks inactive, drops from cache, and emits buff-expired', async () => {
    const { svc, buffRepository } = makeService({ itemRepository: makeItemRepo({ items: [BUFF_ITEM] }) });
    const expired = [];
    svc.on('buff-expired', (e) => expired.push(e));
    const buff = await svc.applyBuff(5, 1, 9, 30, null, true, null);

    const ok = await svc.removeBuff(buff.id, 'manual');

    expect(ok).toBe(true);
    expect(buffRepository.markInactive).toHaveBeenCalledWith(buff.id);
    expect(svc.activeBuffsCache.has(buff.id)).toBe(false);
    expect(expired).toHaveLength(1);
    expect(expired[0].id).toBe(buff.id);
    expect(expired[0].reason).toBe('manual');
    svc.shutdown();
  });

  test('removeBuff returns false for an unknown buff id', async () => {
    const { svc } = makeService();
    const ok = await svc.removeBuff(99999, 'manual');
    expect(ok).toBe(false);
    svc.shutdown();
  });

  test('anonymous (negative userId) buffs live in the anonymous cache and emit events', async () => {
    const { svc } = makeService({ itemRepository: makeItemRepo({ items: [BUFF_ITEM] }) });
    const applied = [];
    const expired = [];
    svc.on('buff-applied', (e) => applied.push(e));
    svc.on('buff-expired', (e) => expired.push(e));

    const buff = await svc.applyBuff(-7, 1, 9, 30, null, true, null);
    expect(typeof buff.id).toBe('string');
    expect(buff.id.startsWith('anon_')).toBe(true);
    expect(svc.anonymousBuffsCache.has(-7)).toBe(true);
    expect(applied).toHaveLength(1);

    const ok = await svc.removeBuff(buff.id, 'expired');
    expect(ok).toBe(true);
    expect(expired).toHaveLength(1);
    expect(expired[0].reason).toBe('expired');
    svc.shutdown();
  });

  test('getActiveBuffsForUser returns client-shaped buffs', async () => {
    const { svc } = makeService({ itemRepository: makeItemRepo({ items: [BUFF_ITEM] }) });
    await svc.applyBuff(5, 1, 9, 30, null, true, null);
    const buffs = await svc.getActiveBuffsForUser(5);
    expect(Array.isArray(buffs)).toBe(true);
    expect(buffs).toHaveLength(1);
    expect(buffs[0]).toHaveProperty('userId', 5);
    expect(buffs[0]).toHaveProperty('remainingSeconds');
    expect(buffs[0]).toHaveProperty('displayName');
    svc.shutdown();
  });

  test('formatBuffForClient maps snake_case rows to camelCase and parses JSON', () => {
    const { svc } = makeService();
    const out = svc.formatBuffForClient({
      id: 1, user_id: 5, item_id: 1, item_name: 'speed', display_name: 'Speed',
      emoji: '⚡', buff_type: 'buff', duration_seconds: 60, remaining_seconds: 42,
      streaming_time_used: 3, applied_at: 'now', applied_by_user_id: 9,
      metadata: '{"k":1}', effect_data: '{"e":2}',
    });
    expect(out.userId).toBe(5);
    expect(out.remainingSeconds).toBe(42);
    expect(out.metadata).toEqual({ k: 1 });
    expect(out.effectData).toEqual({ e: 2 });
    svc.shutdown();
  });

  test('cleanupExpiredBuffs removes each expired row', async () => {
    const buffRepository = makeBuffRepo();
    const { svc } = makeService({ buffRepository });
    // Drain the constructor's fire-and-forget initialize() chain (several
    // await hops ending in its own cleanupExpiredBuffs pass) before we change
    // the findExpired fixture, so only the explicit call below is counted.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const removeSpy = jest.spyOn(svc, 'removeBuff').mockResolvedValue(true);
    buffRepository.findExpired.mockResolvedValue([{ id: 201 }, { id: 202 }]);
    await svc.cleanupExpiredBuffs();
    expect(removeSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledWith(201, 'cleanup');
    expect(removeSpy).toHaveBeenCalledWith(202, 'cleanup');
    svc.shutdown();
  });

  test('applyBuff mirrors buff-applied to io when broadcasts are enabled', async () => {
    const io = { emit: jest.fn(), to: jest.fn().mockReturnValue({ emit: jest.fn() }) };
    const { svc } = makeService({ io, itemRepository: makeItemRepo({ items: [BUFF_ITEM] }) });
    await svc.applyBuff(5, 1, 9, 30, null, false, null);
    expect(io.emit).toHaveBeenCalledWith('buff-applied', expect.any(Object));
    expect(io.emit).toHaveBeenCalledWith('user-buff-update', expect.objectContaining({ userId: 5 }));
    svc.shutdown();
  });

  test('getBuffStats delegates to the repository', async () => {
    const buffRepository = makeBuffRepo();
    buffRepository.getStatsLast7Days.mockResolvedValue([{ name: 'speed' }]);
    const { svc } = makeService({ buffRepository });
    const stats = await svc.getBuffStats();
    expect(stats).toEqual([{ name: 'speed' }]);
    svc.shutdown();
  });

  test('shutdown clears the interval timers', () => {
    const { svc } = makeService();
    // initialize() is async (awaits a cache load) so the intervals may not be
    // set synchronously after construction. Start them explicitly to pin the
    // shutdown teardown contract independent of init timing.
    svc.startDurationUpdates();
    svc.startCacheCleanup();
    expect(svc.updateInterval).not.toBeNull();
    expect(svc.cacheCleanupInterval).not.toBeUndefined();
    svc.shutdown();
    expect(svc.updateInterval).toBeNull();
    expect(svc.cacheCleanupInterval).toBeNull();
  });
});
