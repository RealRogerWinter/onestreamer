// Drives permanentlyDeleteAccount against a REAL in-memory sqlite3 DB (the prod
// driver) to prove: (a) the deleting user's PII rows are gone across tables,
// (b) other users' rows survive, (c) the non-`user_id` tables (gift_transactions,
// recording_sessions) are matched on the right columns, (d) actor-reference
// tables (ip_bans) are RETAINED, and (e) a table missing on this install is
// tolerated with a loud log instead of aborting the whole purge.
jest.mock('../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

const sqlite3 = require('sqlite3');
const logger = require('../../bootstrap/logger');
const AccountLifecycleManager = require('../../services/account/AccountLifecycleManager');

function makeDb() {
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.run(sql, params, (err) => (err ? reject(err) : resolve(true)))
    );
  const get = (sql, params = []) =>
    new Promise((resolve, reject) =>
      db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))
    );
  return { db, run, get };
}

// Minimal schemas keyed by the column the purge matches on.
const SCHEMAS = {
  user_stats: 'user_id INTEGER, points_balance INTEGER',
  user_inventory: 'user_id INTEGER, item_id INTEGER',
  recordings: 'user_id INTEGER, path TEXT',
  bug_reports: 'user_id INTEGER, body TEXT',
  gift_transactions: 'from_user_id INTEGER, to_user_id INTEGER, item_id INTEGER',
  recording_sessions: 'streamer_user_id INTEGER, started_at TEXT',
  ip_bans: 'banned_by_user_id INTEGER, ip TEXT', // retained
};

describe('AccountLifecycleManager.permanentlyDeleteAccount', () => {
  let ctx;
  let manager;
  let purgeAccount;

  beforeEach(async () => {
    jest.clearAllMocks();
    ctx = makeDb();
    for (const [name, cols] of Object.entries(SCHEMAS)) {
      await ctx.run(`CREATE TABLE ${name} (id INTEGER PRIMARY KEY, ${cols})`);
    }
    // Seed user A (1) and user B (2).
    await ctx.run('INSERT INTO user_stats (user_id, points_balance) VALUES (1, 100), (2, 200)');
    await ctx.run('INSERT INTO user_inventory (user_id, item_id) VALUES (1, 7), (2, 7)');
    await ctx.run('INSERT INTO recordings (user_id, path) VALUES (1, "/a"), (2, "/b")');
    await ctx.run('INSERT INTO bug_reports (user_id, body) VALUES (1, "x"), (2, "y")');
    await ctx.run(
      'INSERT INTO gift_transactions (from_user_id, to_user_id, item_id) VALUES (1, 2, 7), (2, 1, 7), (2, 3, 7)'
    );
    await ctx.run('INSERT INTO recording_sessions (streamer_user_id) VALUES (1), (2)');
    await ctx.run('INSERT INTO ip_bans (banned_by_user_id, ip) VALUES (1, "1.1.1.1"), (2, "2.2.2.2")');

    purgeAccount = jest.fn().mockResolvedValue({ changes: 1 });
    const owner = {
      db: ctx.db,
      logDeletionAction: jest.fn().mockResolvedValue(true),
      userRepository: { purgeAccount },
    };
    manager = new AccountLifecycleManager(owner);
  });

  afterEach(() => ctx.db.close());

  const count = async (sql, params) => (await ctx.get(`SELECT COUNT(*) c FROM ${sql}`, params)).c;

  test('purges the user PII rows, keeps other users, and completes despite missing tables', async () => {
    const result = await manager.permanentlyDeleteAccount(1);
    expect(result).toBe(true);

    // user_id tables: A gone, B intact
    expect(await count('user_stats WHERE user_id = 1')).toBe(0);
    expect(await count('user_stats WHERE user_id = 2')).toBe(1);
    expect(await count('user_inventory WHERE user_id = 1')).toBe(0);
    expect(await count('recordings WHERE user_id = 1')).toBe(0);
    expect(await count('bug_reports WHERE user_id = 1')).toBe(0);
    expect(await count('recordings WHERE user_id = 2')).toBe(1);

    // gift_transactions: every row touching A (as sender OR recipient) gone;
    // the 2→3 gift survives.
    expect(await count('gift_transactions WHERE from_user_id = 1 OR to_user_id = 1')).toBe(0);
    expect(await count('gift_transactions')).toBe(1);

    // recording_sessions matched on streamer_user_id
    expect(await count('recording_sessions WHERE streamer_user_id = 1')).toBe(0);
    expect(await count('recording_sessions WHERE streamer_user_id = 2')).toBe(1);

    // users-row anonymization delegated to the repo
    expect(purgeAccount).toHaveBeenCalledWith(1);
  });

  test('RETAINS actor-reference tables (ip_bans) — a moderator deleting their account keeps the bans they issued', async () => {
    await manager.permanentlyDeleteAccount(1);
    expect(await count('ip_bans')).toBe(2); // neither ban removed
    expect(await count('ip_bans WHERE banned_by_user_id = 1')).toBe(1);
  });

  test('a missing table is tolerated with a loud error log, not an aborted purge', async () => {
    // Many listed tables (item_usage_log, points_transactions, clips, ...) were
    // never created here, so each triggers the no-such-table path.
    await expect(manager.permanentlyDeleteAccount(1)).resolves.toBe(true);
    expect(logger.error).toHaveBeenCalled();
    const loggedMissing = logger.error.mock.calls.some((c) => /missing on this install/i.test(c[0]));
    expect(loggedMissing).toBe(true);
  });
});
