// Tests for server/services/ModerationService — orchestrator that
// subscribes to TranscriptionService 'transcription-chunk' events and runs
// Stage 1 in log-only mode (PR-M1 of ADR-0013).
//
// Coverage:
//   - Constructor required-dep validation.
//   - initialize() applies schema, verifies seed integrity, upserts seed
//     terms, loads terms cache, subscribes to chunk events.
//   - handleTranscriptChunk() with a Stage 1 hit writes a moderation_events
//     row, emits via notifier, returns the row.
//   - handleTranscriptChunk() with a clean chunk does NOT write a row.
//   - Per-streamer mutex serializes chunks for the same streamer.
//   - Seed integrity mismatch fails closed when failClosed=true (default).
//   - getEvents / getEvent expose query helpers.
//
// The tests use an in-memory sqlite database opened via the same wrapper
// that production uses (server/database/database.js exports `db`,
// `runAsync`, `getAsync`, `allAsync`), so the same SQL contract is exercised
// — including the CHECK constraints and INSERT OR IGNORE semantics on the
// seed config.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const sqlite3 = require('sqlite3').verbose();

const ModerationService = require('../../services/ModerationService');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'database', 'ai-moderation-schema.sql');
const SEED_PATH = path.join(__dirname, '..', '..', 'data', 'seeds', 'moderation-core-list.json');
const SEED_HASH_PATH = path.join(__dirname, '..', '..', 'data', 'seeds', 'moderation-core-list.sha256');

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

function makeTranscriptionStub() {
  // Real TranscriptionService extends EventEmitter; for tests we just need
  // the on/off contract plus the ability to emit events.
  return new EventEmitter();
}

function makeNotifierStub() {
  return {
    eventCreated: jest.fn(),
    actionTaken: jest.fn(),
    streamerBanner: jest.fn(),
    botOutputDropped: jest.fn(),
  };
}

function makeStreamServiceStub({ streamType = 'webcam', generation = 1 } = {}) {
  return {
    getStreamType: jest.fn(() => streamType),
    getStreamGeneration: jest.fn(() => generation),
    getCurrentStreamer: jest.fn(() => 'sock_test'),
  };
}

function openInMemoryDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

async function buildService(overrides = {}) {
  const db = await openInMemoryDb();
  const wrapper = makeDatabaseWrapper(db);
  const transcriptionService = makeTranscriptionStub();
  const moderationNotifier = makeNotifierStub();
  const streamService = makeStreamServiceStub();

  const svc = new ModerationService({
    database: wrapper,
    transcriptionService,
    moderationNotifier,
    streamService,
    failClosed: true,
    ...overrides,
  });
  return { svc, db, wrapper, transcriptionService, moderationNotifier, streamService };
}

describe('ModerationService.constructor', () => {
  test('requires database', () => {
    expect(() => new ModerationService({
      transcriptionService: {},
      moderationNotifier: {},
      streamService: {},
    })).toThrow(/database/);
  });
  test('requires transcriptionService', () => {
    expect(() => new ModerationService({
      database: {},
      moderationNotifier: {},
      streamService: {},
    })).toThrow(/transcriptionService/);
  });
  test('requires moderationNotifier', () => {
    expect(() => new ModerationService({
      database: {},
      transcriptionService: {},
      streamService: {},
    })).toThrow(/moderationNotifier/);
  });
  test('requires streamService', () => {
    expect(() => new ModerationService({
      database: {},
      transcriptionService: {},
      moderationNotifier: {},
    })).toThrow(/streamService/);
  });
});

describe('ModerationService.initialize', () => {
  test('applies schema, upserts seed, loads cache, subscribes', async () => {
    const { svc, transcriptionService, wrapper } = await buildService();
    // Confirm transcription has no listeners pre-init.
    expect(transcriptionService.listenerCount('transcription-chunk')).toBe(0);

    await svc.initialize();

    // Cache loaded from upserted seed.
    expect(svc.getTermsCacheSnapshot().length).toBeGreaterThan(0);

    // moderation_config seeded with three rows.
    const cfgRows = await wrapper.allAsync('SELECT category, action_mode FROM moderation_config');
    expect(cfgRows.map((r) => r.category).sort()).toEqual(['hate_speech', 'sexual', 'threat']);
    expect(cfgRows.every((r) => r.action_mode === 'auto_ban')).toBe(true);

    // Subscribed to chunk events.
    expect(transcriptionService.listenerCount('transcription-chunk')).toBe(1);

    expect(svc.initialized).toBe(true);
  });

  test('is idempotent', async () => {
    const { svc } = await buildService();
    await svc.initialize();
    const sizeAfterFirst = svc.getTermsCacheSnapshot().length;
    await svc.initialize();
    expect(svc.getTermsCacheSnapshot().length).toBe(sizeAfterFirst);
  });

  test('fails closed on seed hash mismatch (failClosed=true)', async () => {
    // Write a tampered seed to a tmp file, point the service at it, and
    // ensure initialize() throws.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-seed-'));
    const tamperedSeed = path.join(tmpDir, 'seed.json');
    const tamperedHash = path.join(tmpDir, 'seed.sha256');
    fs.writeFileSync(tamperedSeed, JSON.stringify({ version: 1, terms: [] }));
    // Hash file holds an INTENTIONALLY-WRONG hash so verify fails.
    fs.writeFileSync(tamperedHash, '0'.repeat(64));

    const { svc } = await buildService({
      seedPath: tamperedSeed,
      seedHashPath: tamperedHash,
      failClosed: true,
    });
    await expect(svc.initialize()).rejects.toThrow(/seed integrity mismatch/);
  });

  test('warns instead of throwing on hash mismatch when failClosed=false', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-seed-'));
    const tamperedSeed = path.join(tmpDir, 'seed.json');
    const tamperedHash = path.join(tmpDir, 'seed.sha256');
    fs.writeFileSync(tamperedSeed, JSON.stringify({ version: 1, terms: [] }));
    fs.writeFileSync(tamperedHash, '0'.repeat(64));

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { svc } = await buildService({
      seedPath: tamperedSeed,
      seedHashPath: tamperedHash,
      failClosed: false,
    });
    await expect(svc.initialize()).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('seed integrity mismatch'));
    warnSpy.mockRestore();
  });

  test('verifies the real shipped seed file matches its sha256', () => {
    // Direct file-level assertion, not via ModerationService — guards
    // against an edit to either file landing without a hash refresh.
    const seedBytes = fs.readFileSync(SEED_PATH);
    const stored = fs.readFileSync(SEED_HASH_PATH, 'utf8').trim();
    const computed = crypto.createHash('sha256').update(seedBytes).digest('hex');
    expect(computed).toBe(stored);
  });

  test('reads the real schema file successfully', () => {
    expect(fs.existsSync(SCHEMA_PATH)).toBe(true);
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS moderation_terms/);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS moderation_events/);
  });
});

describe('ModerationService.handleTranscriptChunk', () => {
  test('clean chunk writes no row and notifier is not called', async () => {
    const { svc, moderationNotifier, wrapper } = await buildService();
    await svc.initialize();

    const result = await svc.handleTranscriptChunk({
      sessionId: 'sess_1',
      streamerId: 'sock_1',
      chunkNumber: 1,
      text: 'hello world this is a totally clean transcript',
    });
    expect(result).toBeNull();
    expect(moderationNotifier.eventCreated).not.toHaveBeenCalled();
    const rows = await wrapper.allAsync('SELECT * FROM moderation_events');
    expect(rows).toHaveLength(0);
  });

  test('Stage 1 hit writes a moderation_events row with admin_review decision', async () => {
    const { svc, moderationNotifier, wrapper } = await buildService();
    await svc.initialize();
    // Use a term from the embedded seed that we know exists.
    const result = await svc.handleTranscriptChunk({
      sessionId: 'sess_2',
      streamerId: 'sock_2',
      chunkNumber: 1,
      text: 'i would never say faggot but he did',
    });
    expect(result).not.toBeNull();
    expect(result.final_decision).toBe('admin_review');
    expect(moderationNotifier.eventCreated).toHaveBeenCalledTimes(1);
    expect(moderationNotifier.eventCreated.mock.calls[0][0].event.final_decision).toBe('admin_review');

    const rows = await wrapper.allAsync('SELECT * FROM moderation_events ORDER BY id DESC');
    expect(rows).toHaveLength(1);
    expect(rows[0].stage1_hit).toBe(1);
    expect(rows[0].automated_decision).toBe(1);
    expect(rows[0].actor).toBe('system');
    const matched = JSON.parse(rows[0].matched_terms_json);
    expect(Array.isArray(matched)).toBe(true);
    expect(matched[0].category).toBe('hate_speech');
  });

  test('stream_session_id captures the streamService generation at chunk time', async () => {
    const streamService = makeStreamServiceStub({ generation: 17 });
    const { svc, wrapper } = await buildService({ streamService });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_3', text: 'kys' });

    const row = await wrapper.getAsync('SELECT stream_session_id FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.stream_session_id).toBe('17');
  });

  test('per-streamer mutex serializes chunks for the same streamer', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    // Fire three chunks back-to-back without awaiting — they should chain.
    const p1 = svc.handleTranscriptChunk({ streamerId: 'sock_X', text: 'faggot one' });
    const p2 = svc.handleTranscriptChunk({ streamerId: 'sock_X', text: 'faggot two' });
    const p3 = svc.handleTranscriptChunk({ streamerId: 'sock_X', text: 'faggot three' });
    await Promise.all([p1, p2, p3]);

    const rows = await wrapper.allAsync(
      'SELECT id, transcript_excerpt FROM moderation_events ORDER BY id'
    );
    expect(rows).toHaveLength(3);
    // FIFO order preserved.
    expect(rows[0].transcript_excerpt).toBe('faggot one');
    expect(rows[1].transcript_excerpt).toBe('faggot two');
    expect(rows[2].transcript_excerpt).toBe('faggot three');
  });

  test('different streamers process concurrently (mutex is per-streamer)', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    await Promise.all([
      svc.handleTranscriptChunk({ streamerId: 'sock_A', text: 'faggot a' }),
      svc.handleTranscriptChunk({ streamerId: 'sock_B', text: 'faggot b' }),
    ]);
    const rows = await wrapper.allAsync('SELECT streamer_id FROM moderation_events ORDER BY id');
    expect(rows.map((r) => r.streamer_id).sort()).toEqual(['sock_A', 'sock_B']);
  });

  test('subscribes to TranscriptionService events and processes them end-to-end', async () => {
    const { svc, transcriptionService, moderationNotifier } = await buildService();
    await svc.initialize();
    transcriptionService.emit('transcription-chunk', {
      sessionId: 'sess_evt',
      streamerId: 'sock_evt',
      chunkNumber: 1,
      text: 'faggot in chat?',
    });
    // The listener fires handleTranscriptChunk synchronously but its body
    // is async (mutex chain → DB insert → notifier call). Drain the chain
    // for this streamer; if no chain exists, the call already completed.
    const chain = svc._streamerChains.get('sock_evt') || Promise.resolve();
    await chain;
    expect(moderationNotifier.eventCreated).toHaveBeenCalledTimes(1);
  });

  test('stop() unsubscribes and drains in-flight chains', async () => {
    const { svc, transcriptionService } = await buildService();
    await svc.initialize();
    expect(transcriptionService.listenerCount('transcription-chunk')).toBe(1);
    await svc.stop();
    expect(transcriptionService.listenerCount('transcription-chunk')).toBe(0);
    // Post-stop chunks are no-ops.
    const result = await svc.handleTranscriptChunk({ streamerId: 'sock_late', text: 'faggot' });
    expect(result).toBeNull();
  });
});

describe('ModerationService.getEvents / getEvent', () => {
  test('getEvents returns rows in reverse-chronological order (newest first)', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    // SQLite CURRENT_TIMESTAMP is 1-second resolution; the service's
    // secondary `id DESC` sort is what guarantees deterministic ordering
    // for same-second inserts. This test exercises that secondary sort.
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision)
       VALUES ('webcam', 'first', 'admin_review')`
    );
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision)
       VALUES ('webcam', 'second', 'admin_review')`
    );
    const events = await svc.getEvents({ limit: 10 });
    expect(events).toHaveLength(2);
    expect(events[0].transcript_excerpt).toBe('second');
    expect(events[1].transcript_excerpt).toBe('first');
  });

  test('getEvents filters by decision', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision)
       VALUES ('webcam', 'a', 'admin_review'), ('webcam', 'b', 'clean')`
    );
    const onlyReview = await svc.getEvents({ decision: 'admin_review' });
    expect(onlyReview).toHaveLength(1);
    expect(onlyReview[0].transcript_excerpt).toBe('a');
  });

  test('getEvent returns the row by id', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    const r = await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision)
       VALUES ('webcam', 'one', 'admin_review')`
    );
    const row = await svc.getEvent(r.id);
    expect(row.transcript_excerpt).toBe('one');
  });
});
