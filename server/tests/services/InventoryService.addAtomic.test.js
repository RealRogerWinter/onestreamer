// Atomic upsert-increment against the REAL sqlite3 driver (the prod path).
const sqlite3 = require('sqlite3');
const UserInventoryRepository = require('../../database/repository/UserInventoryRepository');
const InventoryService = require('../../services/InventoryService');

// Fence: keep a default-constructed repo from opening the real prod DB.
jest.mock('../../database/database', () => ({
  getAsync: jest.fn(),
  runAsync: jest.fn(),
  allAsync: jest.fn(),
}));

function makeDb() {
  const db = new sqlite3.Database(':memory:');
  const runAsync = (sql, params = []) =>
    new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res({ id: this.lastID, changes: this.changes }); }));
  const getAsync = (sql, params = []) =>
    new Promise((res, rej) => db.get(sql, params, (e, row) => (e ? rej(e) : res(row))));
  const allAsync = (sql, params = []) =>
    new Promise((res, rej) => db.all(sql, params, (e, rows) => (e ? rej(e) : res(rows))));
  return { db, runAsync, getAsync, allAsync };
}

async function setupSchema({ runAsync }, maxStack) {
  await runAsync(`CREATE TABLE items (
    id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, emoji TEXT,
    cooldown_seconds INTEGER DEFAULT 0, max_stack INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1)`);
  await runAsync(`CREATE TABLE user_inventory (
    id INTEGER PRIMARY KEY, user_id INTEGER, item_id INTEGER, quantity INTEGER,
    acquired_at TEXT, last_used_at TEXT, UNIQUE(user_id, item_id))`);
  await runAsync(`INSERT INTO items (id, name, display_name, emoji, max_stack) VALUES (1, 'tomato', 'Tomato', '🍅', ?)`, [maxStack]);
}

describe('InventoryService.addItemToInventory (atomic upsert-increment)', () => {
  let ctx;
  let svc;

  const build = async (maxStack = 0) => {
    ctx = makeDb();
    await setupSchema(ctx, maxStack);
    const repo = new UserInventoryRepository({ getAsync: ctx.getAsync, runAsync: ctx.runAsync, allAsync: ctx.allAsync });
    const itemService = { getItemById: async () => ({ id: 1, max_stack: maxStack }) };
    svc = new InventoryService(itemService, null, { userInventoryRepository: repo, itemTransactionRepository: {} });
  };

  afterEach(() => ctx && ctx.db.close());

  const qtyOf = async () =>
    (await ctx.getAsync('SELECT quantity FROM user_inventory WHERE user_id=1 AND item_id=1'))?.quantity ?? null;
  const seed = (q) => ctx.runAsync('INSERT INTO user_inventory (user_id, item_id, quantity) VALUES (1, 1, ?)', [q]);

  test('inserts a new row', async () => {
    await build(0);
    expect(await svc.addItemToInventory(1, 1, 3)).toEqual({ itemId: 1, quantity: 3, added: 3 });
    expect(await qtyOf()).toBe(3);
  });

  test('increments an existing row', async () => {
    await build(0);
    await seed(5);
    expect(await svc.addItemToInventory(1, 1, 2)).toEqual({ itemId: 1, quantity: 7, added: 2 });
  });

  test('clamps to max_stack in SQL', async () => {
    await build(10);
    await seed(8);
    const res = await svc.addItemToInventory(1, 1, 5);
    expect(res.quantity).toBe(10);
    expect(res.added).toBe(2);
  });

  test('two concurrent adds do NOT lost-update (5 + 1 + 1 = 7)', async () => {
    await build(0);
    await seed(5);
    await Promise.all([svc.addItemToInventory(1, 1, 1), svc.addItemToInventory(1, 1, 1)]);
    expect(await qtyOf()).toBe(7); // a read-modify-write would have produced 6
  });
});
