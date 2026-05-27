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

// PR 12.3 (ADR-0020): the service migrated from `console.warn` to the
// namespaced pino logger. Tests that assert on the warn must spy on the
// mocked logger module instead. `child()` returns the same mock so
// `.child({svc:'X'}).warn` resolves to the same `jest.fn()`.
jest.mock('../../bootstrap/logger', () => {
    const m = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), trace: jest.fn() };
    m.child = jest.fn(() => m);
    return m;
});

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const sqlite3 = require('sqlite3').verbose();

const logger = require('../../bootstrap/logger');
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

function makeStage2Stub(overrides = {}) {
  return {
    isReady: jest.fn(() => true),
    isDegraded: jest.fn(() => false),
    classify: jest.fn(async () => ({
      risk_level: 3,
      categories: ['hate_speech'],
      explanation: 'stub said so',
      model: 'stub-model',
      latency_ms: 42,
    })),
    ...overrides,
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

    logger.warn.mockClear();
    const { svc } = await buildService({
      seedPath: tamperedSeed,
      seedHashPath: tamperedHash,
      failClosed: false,
    });
    await expect(svc.initialize()).resolves.not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('seed integrity mismatch'));
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

  // Regression: TranscriptionService's two backend branches emit
  // `transcription-chunk` with different payload shapes — MediaSoup uses
  // `{text}` and LiveKit (URL-relay) uses `{transcription}`. Before the
  // hotfix, production URL relays went unmoderated because
  // handleTranscriptChunk strictly read `chunk.text`. The defensive read
  // unifies both shapes down to one normalized `text` field.
  test('regression: LiveKit-shape {transcription} is processed identically to {text}', async () => {
    const { svc, moderationNotifier, wrapper } = await buildService();
    await svc.initialize();
    const result = await svc.handleTranscriptChunk({
      sessionId: 'sess_lk',
      streamerId: 'sock_lk',
      // LiveKit path uses `transcription`, not `text` — see
      // server/services/TranscriptionService.js around line 997.
      transcription: 'i would never say faggot but he did',
      isComplete: true,
    });
    expect(result).not.toBeNull();
    expect(result.final_decision).toBe('admin_review');
    expect(moderationNotifier.eventCreated).toHaveBeenCalledTimes(1);
    const row = await wrapper.getAsync('SELECT * FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.transcript_excerpt).toContain('faggot');
  });

  test('regression: empty {transcription} string is rejected like empty {text}', async () => {
    const { svc, moderationNotifier } = await buildService();
    await svc.initialize();
    const r1 = await svc.handleTranscriptChunk({ streamerId: 'sock_e1', transcription: '' });
    expect(r1).toBeNull();
    const r2 = await svc.handleTranscriptChunk({ streamerId: 'sock_e2', text: '' });
    expect(r2).toBeNull();
    expect(moderationNotifier.eventCreated).not.toHaveBeenCalled();
  });

  test('regression: when both {text} and {transcription} are present, prefer text', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    await svc.handleTranscriptChunk({
      streamerId: 'sock_both',
      text: 'faggot from text field',
      transcription: 'kike from transcription field',
    });
    const row = await wrapper.getAsync('SELECT * FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.transcript_excerpt).toBe('faggot from text field');
  });

  // Regression: in production, ViewBotURLService calls
  // streamService.setStreamer(urlId) WITHOUT a streamType arg, so
  // StreamService.setStreamer defaults to 'webcam'. As a result,
  // streamService.getStreamType() reported 'webcam' for URL-relay
  // sessions and moderation_events rows from URL relays were mis-labelled.
  // The recovery: detect the `url-stream-` id prefix in
  // _resolveStreamType(streamerId). Mislabel impact at enforce=true: the
  // ActionArbiter would route to _actWebcam (attempting to ban a user_id
  // that doesn't exist for a URL relay) instead of _actUrlRelay.
  test('regression: url-stream-prefixed streamerId resolves to stream_type=url-relay', async () => {
    const streamService = makeStreamServiceStub({ streamType: 'webcam' }); // production default
    const { svc, wrapper } = await buildService({ streamService });
    await svc.initialize();
    await svc.handleTranscriptChunk({
      streamerId: 'url-stream-1779851056114-2',
      text: 'i would never say faggot but he did',
    });
    const row = await wrapper.getAsync('SELECT stream_type, streamer_id FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.stream_type).toBe('url-relay');
    expect(row.streamer_id).toBe('url-stream-1779851056114-2');
  });

  test('regression: non-prefixed streamerId falls through to streamService.getStreamType', async () => {
    const streamService = makeStreamServiceStub({ streamType: 'viewbot' });
    const { svc, wrapper } = await buildService({ streamService });
    await svc.initialize();
    await svc.handleTranscriptChunk({
      streamerId: 'sock_abc123',
      text: 'i would never say faggot but he did',
    });
    const row = await wrapper.getAsync('SELECT stream_type FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.stream_type).toBe('viewbot');
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

describe('ModerationService Stage 2 integration', () => {
  test('calls Stage 2 only when Stage 1 hits', async () => {
    const stage2 = makeStage2Stub();
    const { svc } = await buildService({ stage2 });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_clean', text: 'hello world' });
    expect(stage2.classify).not.toHaveBeenCalled();
    await svc.handleTranscriptChunk({ streamerId: 'sock_hit', text: 'i am a faggot for sure' });
    expect(stage2.classify).toHaveBeenCalledTimes(1);
  });

  test('passes surrounding context (60s) to Stage 2', async () => {
    const stage2 = makeStage2Stub();
    const { svc } = await buildService({ stage2 });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_ctx', text: 'we were discussing history' });
    await svc.handleTranscriptChunk({ streamerId: 'sock_ctx', text: 'and someone said faggot' });
    expect(stage2.classify).toHaveBeenCalledTimes(1);
    const callArg = stage2.classify.mock.calls[0][0];
    expect(callArg.transcriptExcerpt).toBe('and someone said faggot');
    expect(callArg.surroundingContext).toContain('we were discussing history');
    expect(callArg.surroundingContext).toContain('and someone said faggot');
  });

  test('persists Stage 2 verdict to moderation_events row', async () => {
    const stage2 = makeStage2Stub();
    const { svc, wrapper } = await buildService({ stage2 });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_v', text: 'faggot in chat' });
    const row = await wrapper.getAsync('SELECT * FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.stage2_risk_level).toBe(3);
    expect(JSON.parse(row.stage2_categories_json)).toEqual(['hate_speech']);
    const verdict = JSON.parse(row.stage2_verdict_json);
    expect(verdict.risk_level).toBe(3);
    expect(verdict.explanation).toBe('stub said so');
    // M2 stays log-only: even risk=3 stays admin_review until M3 wires
    // the action arbiter.
    expect(row.final_decision).toBe('admin_review');
    const models = JSON.parse(row.ml_model_versions_json);
    expect(models.stage2).toBe('stub-model');
  });

  test('Stage 2 degraded -> final_decision is deferred_degraded', async () => {
    const stage2 = makeStage2Stub({
      classify: jest.fn(async () => ({ degraded: true, reason: 'breaker_open' })),
    });
    const { svc, wrapper } = await buildService({ stage2 });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_d', text: 'faggot' });
    const row = await wrapper.getAsync('SELECT final_decision, stage2_verdict_json FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('deferred_degraded');
    expect(JSON.parse(row.stage2_verdict_json)).toEqual({ degraded: true, reason: 'breaker_open' });
  });

  test('Stage 2 error -> final_decision is deferred_degraded', async () => {
    const stage2 = makeStage2Stub({
      classify: jest.fn(async () => ({ error: 'groq_500', raw_status: 500, raw_body: 'x' })),
    });
    const { svc, wrapper } = await buildService({ stage2 });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_e', text: 'faggot' });
    const row = await wrapper.getAsync('SELECT final_decision, stage2_verdict_json FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('deferred_degraded');
    expect(JSON.parse(row.stage2_verdict_json).error).toBe('groq_500');
  });

  test('Stage 2 not ready -> no call, row still written with admin_review', async () => {
    const stage2 = makeStage2Stub({ isReady: jest.fn(() => false) });
    const { svc, wrapper } = await buildService({ stage2 });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_skip', text: 'faggot' });
    expect(stage2.classify).not.toHaveBeenCalled();
    const row = await wrapper.getAsync('SELECT final_decision, stage2_verdict_json FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('admin_review');
    expect(row.stage2_verdict_json).toBeNull();
  });

  test('sliding-overlap matching: phrase split across two chunks is caught', async () => {
    const stage2 = makeStage2Stub();
    const { svc } = await buildService({ stage2 });
    await svc.initialize();
    // 'kill all jews' is in the embedded seed as 'threat' hard. Split it
    // across two chunks: a streamer says "i would never kill" then "all
    // jews i swear". Stage 1 on either chunk alone would miss it; the
    // sliding overlap (previous + current) catches it.
    await svc.handleTranscriptChunk({ streamerId: 'sock_split', text: 'i would never kill' });
    expect(stage2.classify).not.toHaveBeenCalled();
    await svc.handleTranscriptChunk({ streamerId: 'sock_split', text: 'all jews i swear' });
    expect(stage2.classify).toHaveBeenCalledTimes(1);
  });
});

describe('ModerationService Stage 3 + ActionArbiter integration', () => {
  function makeStage3Stub(overrides = {}) {
    return {
      isReady: jest.fn(() => true),
      isDegraded: jest.fn(() => false),
      classify: jest.fn(async () => ({
        flagged: true,
        categories: { hate: true },
        scores: { hate: 0.95 },
        model: 'omni-stub',
        latency_ms: 30,
      })),
      ...overrides,
    };
  }
  function makeArbiterStub(overrides = {}) {
    return {
      arbitrate: jest.fn(async () => ({
        final_decision: 'auto_ban',
        action_taken: 'banned:1;rotation=rotated',
      })),
      ...overrides,
    };
  }

  test('Stage 3 not called when Stage 2 risk_level < 3', async () => {
    const stage2 = makeStage2Stub({
      classify: jest.fn(async () => ({
        risk_level: 2,
        categories: ['hate_speech'],
        explanation: 'borderline',
        model: 'stub',
        latency_ms: 10,
      })),
    });
    const stage3 = makeStage3Stub();
    const arbiter = makeArbiterStub();
    const { svc, wrapper } = await buildService({ stage2, stage3, actionArbiter: arbiter });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_low', text: 'faggot' });
    expect(stage3.classify).not.toHaveBeenCalled();
    expect(arbiter.arbitrate).not.toHaveBeenCalled();
    const row = await wrapper.getAsync('SELECT final_decision FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('admin_review');
  });

  test('Stage 3 called on Stage 2 risk_level=3; agreement triggers arbiter', async () => {
    const stage2 = makeStage2Stub();
    const stage3 = makeStage3Stub();
    const arbiter = makeArbiterStub();
    const { svc, wrapper } = await buildService({ stage2, stage3, actionArbiter: arbiter });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_b', text: 'faggot' });
    expect(stage3.classify).toHaveBeenCalledTimes(1);
    expect(arbiter.arbitrate).toHaveBeenCalledTimes(1);
    const row = await wrapper.getAsync('SELECT * FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('auto_ban');
    expect(row.action_taken).toMatch(/banned/);
    const stage3Json = JSON.parse(row.stage3_verdict_json);
    expect(stage3Json.flagged).toBe(true);
  });

  test('Stage 3 disagrees with Stage 2 → admin_review, no arbiter', async () => {
    const stage2 = makeStage2Stub();
    const stage3 = makeStage3Stub({
      classify: jest.fn(async () => ({
        flagged: false,
        categories: {},
        scores: { hate: 0.1 },
        model: 'omni-stub',
        latency_ms: 30,
      })),
    });
    const arbiter = makeArbiterStub();
    const { svc, wrapper } = await buildService({ stage2, stage3, actionArbiter: arbiter });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_dis', text: 'faggot' });
    expect(arbiter.arbitrate).not.toHaveBeenCalled();
    const row = await wrapper.getAsync('SELECT final_decision, action_taken FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('admin_review');
    expect(row.action_taken).toMatch(/stage3_disagreed/);
  });

  test('Stage 3 degraded → final_decision deferred_degraded', async () => {
    const stage2 = makeStage2Stub();
    const stage3 = makeStage3Stub({
      classify: jest.fn(async () => ({ degraded: true, reason: 'breaker_open' })),
    });
    const arbiter = makeArbiterStub();
    const { svc, wrapper } = await buildService({ stage2, stage3, actionArbiter: arbiter });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_deg', text: 'faggot' });
    expect(arbiter.arbitrate).not.toHaveBeenCalled();
    const row = await wrapper.getAsync('SELECT final_decision FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('deferred_degraded');
  });

  test('Stage 3 not ready → admin_review, no arbiter', async () => {
    const stage2 = makeStage2Stub();
    const stage3 = makeStage3Stub({ isReady: jest.fn(() => false) });
    const arbiter = makeArbiterStub();
    const { svc, wrapper } = await buildService({ stage2, stage3, actionArbiter: arbiter });
    await svc.initialize();
    await svc.handleTranscriptChunk({ streamerId: 'sock_nor', text: 'faggot' });
    expect(stage3.classify).not.toHaveBeenCalled();
    expect(arbiter.arbitrate).not.toHaveBeenCalled();
    const row = await wrapper.getAsync('SELECT final_decision, action_taken FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.final_decision).toBe('admin_review');
    expect(row.action_taken).toMatch(/stage3_not_called/);
  });

  test('Stage 3 per-streamer quota gates calls after threshold', async () => {
    const stage2 = makeStage2Stub();
    const stage3 = makeStage3Stub();
    const arbiter = makeArbiterStub();
    const { svc } = await buildService({
      stage2, stage3, actionArbiter: arbiter,
      stage3QuotaPerHour: 2,
    });
    await svc.initialize();
    // First two chunks call Stage 3; the third should hit the quota and skip.
    await svc.handleTranscriptChunk({ streamerId: 'sock_q', text: 'faggot 1' });
    await svc.handleTranscriptChunk({ streamerId: 'sock_q', text: 'faggot 2' });
    await svc.handleTranscriptChunk({ streamerId: 'sock_q', text: 'faggot 3' });
    expect(stage3.classify).toHaveBeenCalledTimes(2);
  });

  test('setActionArbiter replaces the previously-injected arbiter', async () => {
    const stage2 = makeStage2Stub();
    const stage3 = makeStage3Stub();
    const a1 = makeArbiterStub();
    const a2 = makeArbiterStub();
    const { svc } = await buildService({ stage2, stage3, actionArbiter: a1 });
    await svc.initialize();
    svc.setActionArbiter(a2);
    await svc.handleTranscriptChunk({ streamerId: 'sock_r', text: 'faggot' });
    expect(a1.arbitrate).not.toHaveBeenCalled();
    expect(a2.arbitrate).toHaveBeenCalledTimes(1);
  });
});

describe('ModerationService.checkBotOutput (MovieBot output gate)', () => {
  test('clean text → allowed:true, no row written', async () => {
    const stage2 = makeStage2Stub();
    const { svc, moderationNotifier, wrapper } = await buildService({ stage2 });
    await svc.initialize();
    const result = await svc.checkBotOutput('That was a really fun stream segment, classic dad jokes.', { botUsername: 'bot_a' });
    expect(result.allowed).toBe(true);
    expect(stage2.classify).not.toHaveBeenCalled();
    expect(moderationNotifier.botOutputDropped).not.toHaveBeenCalled();
    const rows = await wrapper.allAsync('SELECT * FROM moderation_events');
    expect(rows).toHaveLength(0);
  });

  test('hard-tier word match drops the output and writes a mb_output_dropped row', async () => {
    const stage2 = makeStage2Stub();
    const { svc, moderationNotifier, wrapper } = await buildService({ stage2 });
    await svc.initialize();
    const result = await svc.checkBotOutput('lol what a faggot move from the streamer', { botUsername: 'bot_a' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('hard_tier_word');
    expect(result.eventId).toBeGreaterThan(0);
    expect(moderationNotifier.botOutputDropped).toHaveBeenCalledTimes(1);
    const row = await wrapper.getAsync('SELECT * FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.stream_type).toBe('moviebot-output');
    expect(row.final_decision).toBe('mb_output_dropped');
    expect(row.action_taken).toBe('dropped_hard_tier_word');
    expect(row.surrounding_context).toBe('bot=bot_a');
  });

  test('soft-tier match alone with low Stage 2 risk does NOT drop', async () => {
    // The 'nigga' entry in the seed is 'soft' severity. Stage 2 stub returns
    // risk_level=3 by default; override to a low risk so the soft-tier
    // shouldn't trigger a drop.
    const stage2 = makeStage2Stub({
      classify: jest.fn(async () => ({
        risk_level: 1,
        categories: ['hate_speech'],
        explanation: 'reclaimed AAVE usage',
        model: 'stub', latency_ms: 10,
      })),
    });
    const { svc } = await buildService({ stage2 });
    await svc.initialize();
    // Use a soft-tier reclamation-context word.
    const r = await svc.checkBotOutput('that was so cool nigga, fair play', { botUsername: 'bot_b' });
    expect(r.allowed).toBe(true);
  });

  test('soft-tier match + Stage 2 risk >= 2 drops the output', async () => {
    const stage2 = makeStage2Stub({
      classify: jest.fn(async () => ({
        risk_level: 2,
        categories: ['hate_speech'],
        explanation: 'aggressive use',
        model: 'stub', latency_ms: 10,
      })),
    });
    const { svc, wrapper } = await buildService({ stage2 });
    await svc.initialize();
    const r = await svc.checkBotOutput('shut up retard you are bad at this', { botUsername: 'bot_c' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('stage2_risk');
    const row = await wrapper.getAsync('SELECT * FROM moderation_events ORDER BY id DESC LIMIT 1');
    expect(row.action_taken).toBe('dropped_stage2_risk');
  });

  test('empty / non-string input is allowed (silent pass-through)', async () => {
    const { svc } = await buildService();
    await svc.initialize();
    expect((await svc.checkBotOutput(null)).allowed).toBe(true);
    expect((await svc.checkBotOutput('')).allowed).toBe(true);
    expect((await svc.checkBotOutput(undefined)).allowed).toBe(true);
  });

  test('stopped service short-circuits to allowed:true', async () => {
    const { svc } = await buildService();
    await svc.initialize();
    await svc.stop();
    const r = await svc.checkBotOutput('faggot');
    expect(r.allowed).toBe(true);
  });
});

describe('ModerationService global enforce toggle', () => {
  test('initialize() reads the seeded row and exposes enforce=false via isEnforced()', async () => {
    const { svc } = await buildService();
    await svc.initialize();
    expect(svc.isEnforced()).toBe(false);
    const row = await svc.getGlobalConfig();
    expect(row.enforce).toBe(0);
  });

  test('setEnforce(true) writes DB, updates in-memory cache, propagates to actionArbiter', async () => {
    const stage2 = makeStage2Stub();
    const arbiter = { arbitrate: jest.fn(async () => ({ final_decision: 'auto_ban', action_taken: 'x' })), setEnforce: jest.fn() };
    const { svc, wrapper } = await buildService({ stage2, actionArbiter: arbiter });
    await svc.initialize();
    expect(svc.isEnforced()).toBe(false);
    expect(arbiter.setEnforce).toHaveBeenCalledWith(false); // setActionArbiter sync

    const r = await svc.setEnforce(true, 'admin-test');
    expect(r).toEqual({ ok: true, enforce: true });
    expect(svc.isEnforced()).toBe(true);

    const row = await wrapper.getAsync('SELECT enforce, updated_by FROM moderation_global_config WHERE id = 1');
    expect(row.enforce).toBe(1);
    expect(row.updated_by).toBe('admin-test');

    expect(arbiter.setEnforce).toHaveBeenLastCalledWith(true);
  });

  test('setEnforce is idempotent and round-trips', async () => {
    const { svc } = await buildService();
    await svc.initialize();
    await svc.setEnforce(true, 'a1');
    await svc.setEnforce(true, 'a2');
    await svc.setEnforce(false, 'a3');
    expect(svc.isEnforced()).toBe(false);
    const row = await svc.getGlobalConfig();
    expect(row.enforce).toBe(0);
    expect(row.updated_by).toBe('a3');
  });

  test('env-flag upgrade: AI_MODERATION_ENFORCE=true bumps the seed row on first install', async () => {
    const prev = process.env.AI_MODERATION_ENFORCE;
    process.env.AI_MODERATION_ENFORCE = 'true';
    try {
      const { svc } = await buildService();
      await svc.initialize();
      expect(svc.isEnforced()).toBe(true);
      const row = await svc.getGlobalConfig();
      expect(row.enforce).toBe(1);
      expect(row.updated_by).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.AI_MODERATION_ENFORCE;
      else process.env.AI_MODERATION_ENFORCE = prev;
    }
  });

  test('env-flag upgrade does NOT override an admin-set value', async () => {
    const prev = process.env.AI_MODERATION_ENFORCE;
    delete process.env.AI_MODERATION_ENFORCE;
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    await svc.setEnforce(true, 'admin-test');
    expect(svc.isEnforced()).toBe(true);

    process.env.AI_MODERATION_ENFORCE = 'true';
    try {
      await svc._loadGlobalConfig();
      expect(svc.isEnforced()).toBe(true);
      const row = await wrapper.getAsync('SELECT updated_by FROM moderation_global_config WHERE id = 1');
      expect(row.updated_by).toBe('admin-test');
    } finally {
      if (prev === undefined) delete process.env.AI_MODERATION_ENFORCE;
      else process.env.AI_MODERATION_ENFORCE = prev;
    }
  });

  test('setActionArbiter syncs the current enforce state into a freshly-injected arbiter', async () => {
    const { svc } = await buildService();
    await svc.initialize();
    await svc.setEnforce(true, 'admin-test');

    const lateArbiter = { setEnforce: jest.fn(), arbitrate: jest.fn() };
    svc.setActionArbiter(lateArbiter);
    expect(lateArbiter.setEnforce).toHaveBeenCalledWith(true);
  });
});

describe('ModerationService.purgeOldEvents (PR-M6)', () => {
  test('deletes flagged rows older than retention, keeps recent', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    // Insert two flagged rows: one ancient, one recent.
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision, created_at)
       VALUES ('webcam', 'old', 'admin_review', datetime('now', '-100 days'))`
    );
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision)
       VALUES ('webcam', 'fresh', 'admin_review')`
    );
    const r = await svc.purgeOldEvents({ flaggedRetentionDays: 90, cleanRetentionDays: 30 });
    expect(r.flaggedDeleted).toBe(1);
    const remaining = await wrapper.allAsync('SELECT transcript_excerpt FROM moderation_events');
    expect(remaining.map((row) => row.transcript_excerpt)).toEqual(['fresh']);
  });

  test('deletes clean rows older than clean retention but not within window', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision, created_at)
       VALUES ('webcam', 'old_clean', 'clean', datetime('now', '-40 days'))`
    );
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision, created_at)
       VALUES ('webcam', 'fresh_clean', 'clean', datetime('now', '-10 days'))`
    );
    const r = await svc.purgeOldEvents({ flaggedRetentionDays: 90, cleanRetentionDays: 30 });
    expect(r.cleanDeleted).toBe(1);
    const remaining = await wrapper.allAsync('SELECT transcript_excerpt FROM moderation_events ORDER BY id');
    expect(remaining.map((row) => row.transcript_excerpt)).toEqual(['fresh_clean']);
  });

  test('different retention windows for flagged vs clean', async () => {
    const { svc, wrapper } = await buildService();
    await svc.initialize();
    // 50 days old: keep (clean retention=30 means old, but flagged retention=90 means fresh)
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision, created_at)
       VALUES ('webcam', 'flagged_50', 'admin_review', datetime('now', '-50 days'))`
    );
    await wrapper.runAsync(
      `INSERT INTO moderation_events (stream_type, transcript_excerpt, final_decision, created_at)
       VALUES ('webcam', 'clean_50', 'clean', datetime('now', '-50 days'))`
    );
    await svc.purgeOldEvents({ flaggedRetentionDays: 90, cleanRetentionDays: 30 });
    const rows = await wrapper.allAsync('SELECT transcript_excerpt FROM moderation_events ORDER BY id');
    // flagged_50 stays (under 90d); clean_50 dies (over 30d).
    expect(rows.map((r) => r.transcript_excerpt)).toEqual(['flagged_50']);
  });

  test('startRetentionScheduler is idempotent and stop() clears the timer', async () => {
    const { svc } = await buildService();
    await svc.initialize();
    svc.startRetentionScheduler({ intervalMs: 100_000 });
    const firstTimer = svc._retentionTimer;
    expect(firstTimer).toBeTruthy();
    svc.startRetentionScheduler({ intervalMs: 100_000 });
    expect(svc._retentionTimer).toBe(firstTimer);
    await svc.stop();
    expect(svc._retentionTimer).toBeNull();
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
