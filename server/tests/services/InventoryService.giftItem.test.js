// Tests for the InventoryService.giftItem + getGiftableItems methods added
// in PR 16.3. Companion to the (now-gone) inline /api/internal/gift-item +
// /giftable-items handler bodies that lived in server/routes/internal.js
// pre-Phase-16; covers the eligibility checks and the swap + audit-row
// write the route used to do inline.
//
// What's NOT covered here: the route-layer username → recipientId and
// itemName → item lookups. Those stay in server/routes/internal.js and
// don't pass through this method (the service receives ids only).

jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

// giftItem now runs inside a withTransaction scope (ADR-0029) and writes its
// audit row through the tx handle. Tests inject a fake withTransaction whose
// tx.runAsync delegates to this spy, so the SQL + bindings assertions are
// unchanged.
const mockRunAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('../../database/database', () => ({ runAsync: (...args) => mockRunAsync(...args) }));

// The two repository modules are required at InventoryService module-load.
// Mock them so default-construction doesn't drag in the SQLite adapter.
// UserInventoryRepository's mock constructor returns the CURRENT test double
// (constructor-return override): with tx-scoped repos (ADR-0029) the service
// builds `new UserInventoryRepository(tx)` inside the scope, and this makes
// that instance BE the same double the test asserts on.
const mockInventoryRepoSlot = { current: null };
jest.mock('../../database/repository/UserInventoryRepository', () => class {
  constructor() {
    if (mockInventoryRepoSlot.current) return mockInventoryRepoSlot.current;
  }
});
jest.mock('../../database/repository/ItemTransactionRepository', () => class {});

const InventoryService = require('../../services/InventoryService');
const { InventoryError } = InventoryService;

function makeItemService({ items = [] } = {}) {
  return {
    getItemById: jest.fn().mockImplementation((id) => Promise.resolve(items.find((x) => x.id === id) || null)),
    getAllItems: jest.fn().mockResolvedValue(items),
  };
}

function makeUserInventoryRepo({ inventoryByUser = {} } = {}) {
  // inventoryByUser: { [userId]: [{ item_id, quantity, ...} ] }
  return {
    findInventoryItem: jest.fn().mockImplementation((userId, itemId) => {
      const row = (inventoryByUser[userId] || []).find((x) => x.item_id === itemId);
      return Promise.resolve(row || null);
    }),
    findInventoryWithItemsForUser: jest.fn().mockImplementation((userId) =>
      Promise.resolve(inventoryByUser[userId] || [])
    ),
    updateQuantity: jest.fn().mockResolvedValue(undefined),
    decrementQuantity: jest.fn().mockImplementation((userId, itemId, amount) => {
      const row = (inventoryByUser[userId] || []).find((x) => x.item_id === itemId);
      if (!row || row.quantity < amount) return Promise.resolve(undefined);
      return Promise.resolve({ quantity: row.quantity - amount });
    }),
    incrementQuantity: jest.fn().mockImplementation((userId, itemId, delta) => {
      const row = (inventoryByUser[userId] || []).find((x) => x.item_id === itemId);
      return Promise.resolve({ quantity: (row ? row.quantity : 0) + delta });
    }),
    insertItem: jest.fn().mockResolvedValue(undefined),
    deleteItem: jest.fn().mockResolvedValue(undefined),
    findRecentlyUsed: jest.fn().mockResolvedValue([]),
    deleteAllForUser: jest.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  mockRunAsync.mockClear();
});

describe('InventoryService.giftItem', () => {
  const ITEM = {
    id: 7, name: 'rose', display_name: 'Rose', emoji: '🌹',
    is_tradeable: 1, max_stack: 0, rarity: 'common',
  };
  const SOULBOUND = {
    id: 8, name: 'crown', display_name: 'Crown of Streamerly', emoji: '👑',
    is_tradeable: 0, max_stack: 0, rarity: 'legendary',
  };

  function buildService({ items = [ITEM, SOULBOUND], inventoryByUser = {} } = {}) {
    const itemService = makeItemService({ items });
    const userInventoryRepository = makeUserInventoryRepo({ inventoryByUser });
    mockInventoryRepoSlot.current = userInventoryRepository;
    const svc = new InventoryService(itemService, null, {
      userInventoryRepository,
      itemTransactionRepository: { insertAdminGrant: jest.fn() },
      // Fake scope: tx.runAsync delegates to the module spy so the audit-row
      // assertions keep working (ADR-0029).
      withTransaction: async (fn) => fn({ runAsync: (...args) => mockRunAsync(...args) }),
    });
    return { svc, itemService, userInventoryRepository };
  }

  it('happy path: removes from sender, adds to recipient, writes audit row', async () => {
    const { svc, userInventoryRepository } = buildService({
      inventoryByUser: { 42: [{ item_id: 7, quantity: 5 }] },
    });

    const result = await svc.giftItem(42, 99, 7, 2);

    expect(userInventoryRepository.decrementQuantity).toHaveBeenCalledWith(42, 7, 2); // guarded remove 2 of 5
    expect(userInventoryRepository.incrementQuantity).toHaveBeenCalledWith(99, 7, 2, 0);
    expect(mockRunAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO gift_transactions'),
      [42, 99, 7, 2]
    );
    expect(result).toEqual({
      item: { id: 7, name: 'Rose', emoji: '🌹' },
      quantity: 2,
    });
  });

  it('throws 400 self-gift BEFORE touching the item lookup or inventory', async () => {
    const { svc, itemService, userInventoryRepository } = buildService();

    await expect(svc.giftItem(42, 42, 7, 1)).rejects.toMatchObject({
      statusCode: 400,
      clientMessage: 'Cannot gift items to yourself',
    });
    expect(itemService.getItemById).not.toHaveBeenCalled();
    expect(userInventoryRepository.updateQuantity).not.toHaveBeenCalled();
    expect(userInventoryRepository.insertItem).not.toHaveBeenCalled();
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it('throws 404 when itemId no longer resolves', async () => {
    const { svc } = buildService({ items: [] });

    await expect(svc.giftItem(42, 99, 7, 1)).rejects.toMatchObject({
      statusCode: 404,
      clientMessage: 'Item not found',
    });
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it('throws 400 when item is not is_tradeable (soulbound)', async () => {
    const { svc, userInventoryRepository } = buildService({
      inventoryByUser: { 42: [{ item_id: 8, quantity: 1 }] },
    });

    await expect(svc.giftItem(42, 99, 8, 1)).rejects.toMatchObject({
      statusCode: 400,
      clientMessage: 'Crown of Streamerly cannot be gifted',
    });
    expect(userInventoryRepository.updateQuantity).not.toHaveBeenCalled();
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it('throws 400 with detailed have/need message on insufficient inventory', async () => {
    const { svc, userInventoryRepository } = buildService({
      inventoryByUser: { 42: [{ item_id: 7, quantity: 1 }] },
    });

    await expect(svc.giftItem(42, 99, 7, 5)).rejects.toMatchObject({
      statusCode: 400,
      clientMessage: "You don't have enough Rose to gift (have: 1, need: 5)",
    });
    expect(userInventoryRepository.updateQuantity).not.toHaveBeenCalled();
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it('throws 400 with have: 0 when sender has no inventory row at all', async () => {
    const { svc } = buildService({ inventoryByUser: {} });

    await expect(svc.giftItem(42, 99, 7, 1)).rejects.toMatchObject({
      statusCode: 400,
      clientMessage: "You don't have enough Rose to gift (have: 0, need: 1)",
    });
    expect(mockRunAsync).not.toHaveBeenCalled();
  });

  it('defaults quantity to 1 when not supplied', async () => {
    const { svc, userInventoryRepository } = buildService({
      inventoryByUser: { 42: [{ item_id: 7, quantity: 5 }] },
    });

    await svc.giftItem(42, 99, 7);

    expect(userInventoryRepository.decrementQuantity).toHaveBeenCalledWith(42, 7, 1); // default guarded remove 1
    expect(userInventoryRepository.incrementQuantity).toHaveBeenCalledWith(99, 7, 1, 0);
    expect(mockRunAsync).toHaveBeenCalledWith(expect.any(String), [42, 99, 7, 1]);
  });
});

describe('InventoryService.getGiftableItems', () => {
  it('filters down to is_tradeable rows with quantity > 0', async () => {
    const items = [
      { id: 1, name: 'rose', display_name: 'Rose', emoji: '🌹', is_tradeable: 1, rarity: 'common' },
      { id: 2, name: 'crown', display_name: 'Crown', emoji: '👑', is_tradeable: 0, rarity: 'legendary' },
      { id: 3, name: 'cake', display_name: 'Cake', emoji: '🎂', is_tradeable: 1, rarity: 'rare' },
    ];
    const inventory = [
      { item_id: 1, quantity: 5 },  // tradeable, included
      { item_id: 2, quantity: 1 },  // soulbound, excluded
      { item_id: 3, quantity: 0 },  // zero quantity, excluded
    ];

    const itemService = makeItemService({ items });
    const userInventoryRepository = makeUserInventoryRepo({ inventoryByUser: { 42: inventory } });
    const svc = new InventoryService(itemService, null, {
      userInventoryRepository,
      itemTransactionRepository: {},
    });

    const result = await svc.getGiftableItems(42);

    expect(result).toEqual([
      { id: 1, name: 'rose', display_name: 'Rose', emoji: '🌹', quantity: 5, rarity: 'common' },
    ]);
  });

  it('returns an empty array when the user owns nothing', async () => {
    const itemService = makeItemService({ items: [] });
    const userInventoryRepository = makeUserInventoryRepo({ inventoryByUser: { 42: [] } });
    const svc = new InventoryService(itemService, null, {
      userInventoryRepository,
      itemTransactionRepository: {},
    });

    const result = await svc.getGiftableItems(42);
    expect(result).toEqual([]);
  });

  it('skips inventory rows whose item_id no longer resolves', async () => {
    // A stale row pointing at a deleted item shouldn't crash the response;
    // getItemById returns null and the row is silently dropped — matches
    // the pre-PR inline handler's behaviour.
    const itemService = makeItemService({ items: [] });
    const userInventoryRepository = makeUserInventoryRepo({
      inventoryByUser: { 42: [{ item_id: 999, quantity: 1 }] },
    });
    const svc = new InventoryService(itemService, null, {
      userInventoryRepository,
      itemTransactionRepository: {},
    });

    const result = await svc.getGiftableItems(42);
    expect(result).toEqual([]);
  });
});

describe('InventoryError', () => {
  it('is an Error subclass with statusCode / clientMessage', () => {
    const err = new InventoryError(400, 'Cannot gift items to yourself');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InventoryError');
    expect(err.statusCode).toBe(400);
    expect(err.clientMessage).toBe('Cannot gift items to yourself');
    expect(err.message).toBe('Cannot gift items to yourself');
  });
});
