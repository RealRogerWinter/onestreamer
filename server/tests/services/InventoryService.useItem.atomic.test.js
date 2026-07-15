// Audit E5 — useItem must consume the item BEFORE applying its effect.
//
// Pre-fix, useItem applied the buff/debuff first and only then ran the atomic
// guarded decrement — so two concurrent uses of a 1-stack could BOTH apply
// the effect (double-effect race) even though only one decrement succeeded.
// Post-fix the atomic decrement gates the effect: exactly one racer applies
// it, and a failed effect application compensates by re-adding the unit.
//
// Same real-sqlite3-in-memory harness as InventoryService.removeAtomic.test.js.
const sqlite3 = require('sqlite3');
const UserInventoryRepository = require('../../database/repository/UserInventoryRepository');
const InventoryService = require('../../services/InventoryService');

// Fence: stop any transitive require('../database') (e.g. a default-constructed
// repo) from opening the REAL production DB. Our repo is wired to an in-memory
// sqlite3 handle via injected primitives, so this mock is purely a safety net.
jest.mock('../../database/database', () => ({
  getAsync: jest.fn(),
  runAsync: jest.fn(),
  allAsync: jest.fn(),
}));

function makeDb() {
  const db = new sqlite3.Database(':memory:');
  const runAsync = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      })
    );
  const getAsync = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
    );
  const allAsync = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))
    );
  return { db, runAsync, getAsync, allAsync };
}

async function setupSchema({ runAsync }) {
  await runAsync(`CREATE TABLE items (
    id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, emoji TEXT,
    item_type TEXT, cooldown_seconds INTEGER DEFAULT 0, max_stack INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  )`);
  await runAsync(`CREATE TABLE user_inventory (
    id INTEGER PRIMARY KEY, user_id INTEGER, item_id INTEGER, quantity INTEGER,
    acquired_at TEXT, last_used_at TEXT, UNIQUE(user_id, item_id)
  )`);
  await runAsync(`INSERT INTO items (id, name, display_name, emoji, item_type)
                  VALUES (1, 'tomato', 'Tomato', '🍅', 'debuff')`);
}

const ITEM = Object.freeze({
  id: 1,
  name: 'tomato',
  display_name: 'Tomato',
  emoji: '🍅',
  item_type: 'debuff',
  cooldown_seconds: 0,
  max_stack: 0,
});

describe('InventoryService.useItem (decrement-before-effect, audit E5)', () => {
  let ctx;
  let svc;
  let itemService;

  beforeEach(async () => {
    ctx = makeDb();
    await setupSchema(ctx);
    const repo = new UserInventoryRepository({
      getAsync: ctx.getAsync,
      runAsync: ctx.runAsync,
      allAsync: ctx.allAsync,
    });
    itemService = {
      getItemById: jest.fn(async () => ({ ...ITEM })),
      validateItemUsage: jest.fn(async () => ({ valid: true })),
      isBuffOrDebuffItem: jest.fn(() => true),
      applyBuffDebuffItem: jest.fn(async () => ({
        id: 7,
        duration_seconds: 60,
        remaining_seconds: 60,
        buff_type: 'debuff',
      })),
      applyItemCooldown: jest.fn(async () => {}),
    };
    // Second arg (buffDebuffService) only needs to be truthy — useItem passes
    // it through to itemService.applyBuffDebuffItem, which is mocked here.
    svc = new InventoryService(itemService, {}, {
      userInventoryRepository: repo,
      itemTransactionRepository: {},
    });
  });

  afterEach(() => ctx.db.close());

  const seed = (qty) =>
    ctx.runAsync('INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (1, 1, ?)', [qty]);
  const qtyOf = async () =>
    (await ctx.getAsync('SELECT quantity FROM user_inventory WHERE user_id=1 AND item_id=1'))?.quantity ?? null;

  test('happy path: consumes one unit then applies the effect', async () => {
    await seed(2);
    const result = await svc.useItem(1, 1);
    expect(result.success).toBe(true);
    expect(result.buffApplied).toMatchObject({ id: 7, buffType: 'debuff' });
    expect(itemService.applyBuffDebuffItem).toHaveBeenCalledTimes(1);
    expect(await qtyOf()).toBe(1);
  });

  test('quantity=1 + two concurrent uses → exactly ONE effect application (the E5 race)', async () => {
    await seed(1);
    const results = await Promise.allSettled([
      svc.useItem(1, 1),
      svc.useItem(1, 1),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // The fix: pre-fix BOTH racers reached applyBuffDebuffItem before either
    // decremented, double-applying the effect off a single item.
    expect(itemService.applyBuffDebuffItem).toHaveBeenCalledTimes(1);
    expect(await qtyOf()).toBeNull(); // exactly one unit consumed, row deleted at 0
  });

  test('effect application failure compensates: unit is re-added and the error propagates', async () => {
    await seed(1);
    itemService.applyBuffDebuffItem.mockRejectedValueOnce(new Error('buff service exploded'));
    await expect(svc.useItem(1, 1)).rejects.toThrow('buff service exploded');
    expect(await qtyOf()).toBe(1); // compensated — the user keeps the item
    expect(itemService.applyItemCooldown).not.toHaveBeenCalled();
  });

  test('non-buff items just consume the unit (no effect call)', async () => {
    itemService.isBuffOrDebuffItem.mockReturnValue(false);
    await seed(1);
    const result = await svc.useItem(1, 1);
    expect(result.success).toBe(true);
    expect(result.buffApplied).toBeUndefined();
    expect(itemService.applyBuffDebuffItem).not.toHaveBeenCalled();
    expect(await qtyOf()).toBeNull();
  });
});
