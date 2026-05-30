// Exercises the atomic guarded decrement against the REAL sqlite3 driver — the
// production path (USE_BETTER_SQLITE3 is off in prod). The better-sqlite3 adapter
// uses the identical SQL and is covered by the maintainer's matching-ABI suite.
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
    cooldown_seconds INTEGER DEFAULT 0, max_stack INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1
  )`);
  await runAsync(`CREATE TABLE user_inventory (
    id INTEGER PRIMARY KEY, user_id INTEGER, item_id INTEGER, quantity INTEGER,
    acquired_at TEXT, last_used_at TEXT, UNIQUE(user_id, item_id)
  )`);
  await runAsync(`INSERT INTO items (id, name, display_name, emoji) VALUES (1, 'tomato', 'Tomato', '🍅')`);
}

describe('InventoryService.removeItemFromInventory (atomic guarded decrement)', () => {
  let ctx;
  let svc;

  beforeEach(async () => {
    ctx = makeDb();
    await setupSchema(ctx);
    const repo = new UserInventoryRepository({
      getAsync: ctx.getAsync,
      runAsync: ctx.runAsync,
      allAsync: ctx.allAsync,
    });
    svc = new InventoryService({}, null, {
      userInventoryRepository: repo,
      itemTransactionRepository: {},
    });
  });

  afterEach(() => ctx.db.close());

  const seed = (qty) =>
    ctx.runAsync('INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (1, 1, ?)', [qty]);
  const qtyOf = async () =>
    (await ctx.getAsync('SELECT quantity FROM user_inventory WHERE user_id=1 AND item_id=1'))?.quantity ?? null;

  test('happy path decrements and returns the new quantity', async () => {
    await seed(3);
    const res = await svc.removeItemFromInventory(1, 1, 1);
    expect(res).toEqual({ itemId: 1, quantity: 2, removed: 1 });
    expect(await qtyOf()).toBe(2);
  });

  test('decrementing to zero deletes the row', async () => {
    await seed(1);
    const res = await svc.removeItemFromInventory(1, 1, 1);
    expect(res.quantity).toBe(0);
    expect(await qtyOf()).toBeNull();
  });

  test('two concurrent removes of a 1-stack: exactly one wins, the other throws', async () => {
    await seed(1);
    const results = await Promise.allSettled([
      svc.removeItemFromInventory(1, 1, 1),
      svc.removeItemFromInventory(1, 1, 1),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1); // the fix: NOT both
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/Insufficient quantity|Item not in inventory/);
    expect(await qtyOf()).toBeNull(); // exactly one unit consumed
  });

  test('insufficient quantity throws and leaves the stack intact', async () => {
    await seed(1);
    await expect(svc.removeItemFromInventory(1, 1, 2)).rejects.toThrow('Insufficient quantity');
    expect(await qtyOf()).toBe(1);
  });

  test('missing item throws "Item not in inventory"', async () => {
    await expect(svc.removeItemFromInventory(1, 1, 1)).rejects.toThrow('Item not in inventory');
  });
});
