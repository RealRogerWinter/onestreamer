// Tests for SchemaSeed's PRAGMA-checked idempotent ALTER (audit M5) — the
// resolved_user_id column on moderation_events must exist after applySchema
// on BOTH a fresh database and an existing pre-M5 database, and re-applying
// must be a no-op (this is the new migration mechanism, distinct from the
// duplicate-column-tolerant ALTERs in the .sql file, so it gets its own
// coverage against a real sqlite driver).

jest.mock('../../../bootstrap/logger', () => {
  const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  m.child = jest.fn(() => m);
  return m;
});

const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const SchemaSeed = require('../../../services/moderation/SchemaSeed');

const SCHEMA_PATH = path.join(__dirname, '..', '..', '..', 'database', 'ai-moderation-schema.sql');
const SEED_PATH = path.join(__dirname, '..', '..', '..', 'data', 'seeds', 'moderation-core-list.json');
const SEED_HASH_PATH = path.join(__dirname, '..', '..', '..', 'data', 'seeds', 'moderation-core-list.sha256');

function makeDatabaseWrapper(db) {
  return {
    db,
    runAsync: (sql, params = []) =>
      new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, changes: this.changes });
        });
      }),
    getAsync: (sql, params = []) =>
      new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
      }),
    allAsync: (sql, params = []) =>
      new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
      }),
  };
}

function openInMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => (err ? reject(err) : resolve(db)));
  });
}

function makeSeed(wrapper) {
  return new SchemaSeed({
    database: wrapper,
    schemaPath: SCHEMA_PATH,
    seedPath: SEED_PATH,
    seedHashPath: SEED_HASH_PATH,
    failClosed: true,
  });
}

async function columnNames(wrapper, table) {
  const cols = await wrapper.allAsync(`PRAGMA table_info(${table})`);
  return cols.map((c) => c.name);
}

describe('SchemaSeed resolved_user_id migration (M5)', () => {
  let db;
  let wrapper;
  afterEach(() => new Promise((resolve) => db.close(resolve)));

  test('fresh database: applySchema adds resolved_user_id; second apply is a no-op', async () => {
    db = await openInMemoryDb();
    wrapper = makeDatabaseWrapper(db);
    const seed = makeSeed(wrapper);

    await seed.applySchema();
    expect(await columnNames(wrapper, 'moderation_events')).toContain('resolved_user_id');

    // Idempotency: re-apply must not throw and must not duplicate.
    await seed.applySchema();
    const names = await columnNames(wrapper, 'moderation_events');
    expect(names.filter((n) => n === 'resolved_user_id')).toHaveLength(1);
  });

  test('existing pre-M5 database (table without the column) gains it via the PRAGMA-checked ALTER', async () => {
    db = await openInMemoryDb();
    wrapper = makeDatabaseWrapper(db);
    // Build a prod-shaped pre-M5 database: apply the real schema, then drop
    // the new column so the table matches what an existing install has.
    const seed = makeSeed(wrapper);
    await seed.applySchema();
    await wrapper.runAsync('ALTER TABLE moderation_events DROP COLUMN resolved_user_id;');
    expect(await columnNames(wrapper, 'moderation_events')).not.toContain('resolved_user_id');

    // The upgrade path: re-applying the schema PRAGMA-checks and re-adds it.
    await seed.applySchema();
    expect(await columnNames(wrapper, 'moderation_events')).toContain('resolved_user_id');

    // The column is usable.
    await wrapper.runAsync(
      `INSERT INTO moderation_events (streamer_id, stream_type, transcript_excerpt, final_decision, resolved_user_id)
       VALUES ('sock_a', 'webcam', 'x', 'auto_ban', 42)`
    );
    const row = await wrapper.getAsync('SELECT resolved_user_id FROM moderation_events LIMIT 1');
    expect(row.resolved_user_id).toBe(42);
  });

  test('_ensureColumn surfaces a real ALTER failure instead of swallowing it', async () => {
    db = await openInMemoryDb();
    wrapper = makeDatabaseWrapper(db);
    const seed = makeSeed(wrapper);
    // No such table → PRAGMA returns empty → ALTER fails loudly.
    await expect(seed._ensureColumn('no_such_table', 'resolved_user_id', 'INTEGER'))
      .rejects.toThrow(/no such table/i);
  });
});
