// server/services/ModerationService.js
//
// Orchestrator for the AI moderation pipeline (PR-M1 of [ADR-0013]).
//
// Subscribes to TranscriptionService 'transcription-chunk' events, runs the
// chunk through Stage 1 (normalize + match), and — when there's a hit —
// writes a moderation_events row and emits via ModerationNotifier. PR-M1
// is **log-only**: no Stage 2, no Stage 3, no action arbiter, no bans.
// Every Stage 1 hit lands in moderation_events with `final_decision =
// 'admin_review'` so the admin UI (PR-M5) can list them and the operator
// can validate Stage 1 quality before turning on enforcement.
//
// Why a stateful service rather than a per-event-handler module:
//   - Owns an in-memory cache of enabled moderation_terms (refreshed on
//     admin edits in PR-M5; for M1 a one-shot load on initialize() suffices).
//   - Owns the per-streamer mutex chain that serializes processing within
//     a single session (so chunks-in-flight during Stage 2/3 latency don't
//     double-classify in M2+).
//   - Owns the seed-integrity boot check (fails closed on SHA-256 mismatch).
//
// Per-streamer mutex:
//   _streamerChains: Map<streamerId, Promise>
//   Each chunk handler does:
//     const prev = this._streamerChains.get(streamerId) || Promise.resolve();
//     const next = prev.then(() => this._processChunk(chunk));
//     this._streamerChains.set(streamerId, next);
//   The promise chain ensures FIFO ordering per streamer without blocking
//   different streamers from each other. Chain cleanup happens lazily on
//   stream end (PR-M3 will hook this when the action arbiter ties into the
//   rotation lock).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const Stage1 = require('./ModerationStage1');

const DEFAULT_SEED_PATH = path.join(__dirname, '..', 'data', 'seeds', 'moderation-core-list.json');
const DEFAULT_SEED_HASH_PATH = path.join(__dirname, '..', 'data', 'seeds', 'moderation-core-list.sha256');
const DEFAULT_SCHEMA_PATH = path.join(__dirname, '..', 'database', 'ai-moderation-schema.sql');

class ModerationService extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.database          OneStreamer sqlite wrapper (db, runAsync, getAsync, allAsync).
   * @param {object} deps.transcriptionService  Source of 'transcription-chunk' events.
   * @param {object} deps.moderationNotifier    Socket emit chokepoint.
   * @param {object} deps.streamService     Stream-state lookup (type, generation).
   * @param {object} [deps.stage2]          ModerationStage2 instance. If absent
   *                                        or its isReady() returns false,
   *                                        Stage 2 is skipped (M1 log-only).
   * @param {object} [deps.stage3]          ModerationStage3 instance. If absent
   *                                        or its isReady() returns false,
   *                                        the 2-of-2 cross-check downgrades
   *                                        to admin_review.
   * @param {object} [deps.actionArbiter]   ModerationActionArbiter instance.
   *                                        If absent, no enforcement runs
   *                                        even on 2-of-2 HIGH agreement.
   * @param {number} [deps.contextWindowMs] How much surrounding context to
   *                                        retain per streamer for Stage 2.
   *                                        Default 60000 (60s).
   * @param {number} [deps.stage3QuotaPerHour=20] Per-streamer Stage 3 calls/hr cap.
   * @param {string} [deps.seedPath]        Override embedded seed file path (tests).
   * @param {string} [deps.seedHashPath]    Override SHA-256 sibling file path (tests).
   * @param {string} [deps.schemaPath]      Override schema file path (tests).
   * @param {boolean} [deps.failClosed=true] If true, throw on seed-hash mismatch.
   *                                        If false (tests), log and continue.
   */
  constructor(deps = {}) {
    super();
    const {
      database,
      transcriptionService,
      moderationNotifier,
      streamService,
      stage2 = null,
      stage3 = null,
      actionArbiter = null,
      contextWindowMs = 60_000,
      stage3QuotaPerHour = 20,
      seedPath = DEFAULT_SEED_PATH,
      seedHashPath = DEFAULT_SEED_HASH_PATH,
      schemaPath = DEFAULT_SCHEMA_PATH,
      failClosed = true,
    } = deps;

    if (!database) throw new Error('ModerationService requires a database');
    if (!transcriptionService) throw new Error('ModerationService requires a transcriptionService');
    if (!moderationNotifier) throw new Error('ModerationService requires a moderationNotifier');
    if (!streamService) throw new Error('ModerationService requires a streamService');

    this.database = database;
    this.transcriptionService = transcriptionService;
    this.moderationNotifier = moderationNotifier;
    this.streamService = streamService;
    this.stage2 = stage2;
    this.stage3 = stage3;
    this.actionArbiter = actionArbiter;
    this.contextWindowMs = contextWindowMs;
    this.stage3QuotaPerHour = stage3QuotaPerHour;
    // Per-streamer rolling window of recent Stage 3 call timestamps (ms).
    // Trimmed on each access so memory stays bounded.
    this._stage3CallsByStreamer = new Map();
    this.seedPath = seedPath;
    this.seedHashPath = seedHashPath;
    this.schemaPath = schemaPath;
    this.failClosed = failClosed;

    this._termsCache = [];
    this._termsCacheAt = 0;
    this._streamerChains = new Map();
    // Per-streamer rolling context buffer used by Stage 2. Each entry:
    // { text: string, t: ms-epoch }. Capped by contextWindowMs.
    this._contextBuffers = new Map();
    // Per-streamer previous-chunk text used for sliding-overlap Stage 1.
    // A phrase that straddles the 5s chunk boundary lands intact in the
    // concatenation of chunk N-1 and chunk N.
    this._previousChunkText = new Map();
    this._chunkListener = null;
    this._stopped = false;
    this.initialized = false;
  }

  // ── Initialization ─────────────────────────────────────────────────────

  async initialize() {
    if (this.initialized) return;

    await this._applySchema();
    await this._verifySeedIntegrity();
    await this._upsertEmbeddedTerms();
    await this._loadTermsCache();
    await this._loadGlobalConfig();
    this._subscribeToTranscriptionChunks();

    this.initialized = true;
    console.log(`✅ ModerationService initialized (terms=${this._termsCache.length}, enforce=${this._enforce ? 'on' : 'off'})`);
  }

  /**
   * Load the singleton global-config row. Replaces the boot-time-only
   * `AI_MODERATION_ENFORCE` env flag with a DB-backed runtime-mutable
   * value. The env flag is honored ONCE at first install: if the DB row
   * is still the seed default (enforce=0, updated_by='seed') AND the env
   * says enforce=true, we upgrade the row so operators upgrading from a
   * pre-toggle build don't suddenly lose their enforce=true setting.
   * Subsequent admin toggles take precedence — once an admin has touched
   * the row, the env flag is ignored.
   */
  async _loadGlobalConfig() {
    let row = null;
    try {
      row = await this.database.getAsync('SELECT enforce, updated_by FROM moderation_global_config WHERE id = 1');
    } catch (err) {
      console.warn('⚠️ ModerationService: could not read moderation_global_config:', err.message);
    }

    if (row && row.updated_by === 'seed' && process.env.AI_MODERATION_ENFORCE === 'true') {
      try {
        await this.database.runAsync(
          `UPDATE moderation_global_config
             SET enforce = 1, updated_at = CURRENT_TIMESTAMP, updated_by = 'env'
           WHERE id = 1 AND updated_by = 'seed'`
        );
        console.log('✅ ModerationService: upgraded global enforce 0→1 from AI_MODERATION_ENFORCE env (first-install path)');
        row = { enforce: 1, updated_by: 'env' };
      } catch (err) {
        console.warn('⚠️ ModerationService: env-flag upgrade failed:', err.message);
      }
    }

    this._enforce = !!(row && row.enforce === 1);
    // Propagate to a constructor-injected arbiter as well. setActionArbiter()
    // covers late-injected ones; this covers the build-time case where the
    // arbiter was passed via deps.actionArbiter and initialize() then loaded
    // the authoritative DB value.
    if (this.actionArbiter && typeof this.actionArbiter.setEnforce === 'function') {
      this.actionArbiter.setEnforce(this._enforce);
    }
  }

  /**
   * Read the current enforce state (in-memory cache).
   */
  isEnforced() {
    return !!this._enforce;
  }

  /**
   * Read the global-config row (full shape for the admin UI).
   */
  async getGlobalConfig() {
    const row = await this.database.getAsync(
      'SELECT enforce, updated_at, updated_by FROM moderation_global_config WHERE id = 1'
    );
    return row || { enforce: 0, updated_at: null, updated_by: null };
  }

  /**
   * Flip the global enforce switch. Writes DB and propagates to the
   * currently-injected ActionArbiter (if any) so the next arbitrate()
   * call uses the new value WITHOUT a service restart. Returns
   * `{ ok, enforce }`.
   */
  async setEnforce(enforce, adminId) {
    const next = enforce ? 1 : 0;
    await this.database.runAsync(
      `UPDATE moderation_global_config
         SET enforce = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
       WHERE id = 1`,
      [next, adminId || null]
    );
    this._enforce = !!next;
    if (this.actionArbiter && typeof this.actionArbiter.setEnforce === 'function') {
      this.actionArbiter.setEnforce(this._enforce);
    }
    return { ok: true, enforce: this._enforce };
  }

  /**
   * Apply ai-moderation-schema.sql. Idempotent (CREATE TABLE IF NOT EXISTS
   * + INSERT OR IGNORE on the config seed). Mirrors WhitelistService's
   * _applySchema pattern. Strips `--` line comments BEFORE splitting on `;`
   * so any semicolons inside comments don't break the split.
   */
  async _applySchema() {
    let schema;
    try {
      schema = fs.readFileSync(this.schemaPath, 'utf8');
    } catch (err) {
      const msg = `ModerationService: cannot read schema file at ${this.schemaPath}: ${err.message}`;
      if (this.failClosed) throw new Error(msg);
      console.warn('⚠️ ' + msg);
      return;
    }

    const commentStripped = schema
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--');
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join('\n');

    const statements = commentStripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      try {
        await this.database.runAsync(stmt + ';');
      } catch (err) {
        console.error('❌ ModerationService: schema statement failed:', err.message);
        console.error('   Offending statement:', stmt.slice(0, 200));
        throw err;
      }
    }
  }

  /**
   * Verify the embedded seed file against its SHA-256 sibling. On mismatch:
   * fail closed (throw) if failClosed=true, else log and continue. The
   * seed file is committed alongside its checksum so any out-of-band edit
   * is detected at boot, matching the WhitelistService startup pattern.
   */
  async _verifySeedIntegrity() {
    let seedBytes;
    let storedHash;
    try {
      seedBytes = fs.readFileSync(this.seedPath);
    } catch (err) {
      const msg = `ModerationService: cannot read seed file at ${this.seedPath}: ${err.message}`;
      if (this.failClosed) throw new Error(msg);
      console.warn('⚠️ ' + msg);
      return;
    }
    try {
      storedHash = fs.readFileSync(this.seedHashPath, 'utf8').trim();
    } catch (err) {
      const msg = `ModerationService: cannot read seed hash file at ${this.seedHashPath}: ${err.message}`;
      if (this.failClosed) throw new Error(msg);
      console.warn('⚠️ ' + msg);
      return;
    }
    const computed = crypto.createHash('sha256').update(seedBytes).digest('hex');
    if (computed !== storedHash) {
      const msg = `ModerationService: seed integrity mismatch (computed=${computed.slice(0, 16)}, stored=${storedHash.slice(0, 16)})`;
      if (this.failClosed) throw new Error(msg);
      console.warn('⚠️ ' + msg);
      return;
    }
    console.log('✅ ModerationService: seed integrity verified');
  }

  /**
   * Upsert embedded terms from the seed JSON into the moderation_terms
   * table with source='embedded'. Idempotent: a `INSERT OR IGNORE` on the
   * UNIQUE(normalized_form, category) constraint plus an UPDATE that flips
   * `enabled` back to 1 (so an admin can't permanently disable an embedded
   * term — they can only soft-disable until the next boot, at which point
   * the seed wins).
   *
   * NOTE: Re-enabling on every boot is deliberate. Stage 1 is recall-only,
   * and an admin who wants a hard-tier slur permanently off the list
   * should remove it from the seed file (and update the SHA-256) rather
   * than rely on a runtime override that vanishes on restart. The audit
   * log will show the disable, the re-enable on boot, and the admin's
   * decision history.
   */
  async _upsertEmbeddedTerms() {
    let seed;
    try {
      seed = JSON.parse(fs.readFileSync(this.seedPath, 'utf8'));
    } catch (err) {
      console.warn('⚠️ ModerationService: failed to parse seed JSON:', err.message);
      return;
    }
    if (!seed || !Array.isArray(seed.terms)) {
      console.warn('⚠️ ModerationService: seed JSON has no terms array');
      return;
    }

    let inserted = 0;
    let restored = 0;
    for (const entry of seed.terms) {
      if (!entry || typeof entry.term !== 'string') continue;
      const normalized = Stage1.normalize(entry.normalized_form || entry.term);
      if (!normalized) continue;

      try {
        // INSERT OR IGNORE: if the (normalized_form, category) pair exists,
        // the row is left alone — including its `enabled` flag.
        const result = await this.database.runAsync(
          `INSERT OR IGNORE INTO moderation_terms
              (term, normalized_form, category, severity, source, enabled, created_by, notes)
            VALUES (?, ?, ?, ?, 'embedded', 1, 'seed', ?)`,
          [entry.term, normalized, entry.category, entry.severity || 'hard', entry.notes || null]
        );
        if (result && (result.changes > 0 || result.lastID)) {
          inserted += 1;
        } else {
          // Row already existed. Re-enable it (the boot-wins policy noted
          // above) and refresh source='embedded' attribution if an admin
          // had cloned the row.
          const upd = await this.database.runAsync(
            `UPDATE moderation_terms
                SET enabled = 1, source = 'embedded'
              WHERE normalized_form = ? AND category = ? AND (enabled = 0 OR source <> 'embedded')`,
            [normalized, entry.category]
          );
          if (upd && upd.changes > 0) restored += 1;
        }
      } catch (err) {
        console.warn(`⚠️ ModerationService: upsert failed for term "${entry.term}":`, err.message);
      }
    }
    console.log(`✅ ModerationService: seed upserted (inserted=${inserted}, restored=${restored}, total=${seed.terms.length})`);
  }

  /**
   * Load all enabled moderation_terms rows into the in-memory cache used
   * by Stage 1. Refreshed on admin edits in PR-M5; for M1 a one-shot load
   * at boot suffices.
   */
  async _loadTermsCache() {
    try {
      const rows = await this.database.allAsync(
        `SELECT id, term, normalized_form, category, severity, source
           FROM moderation_terms
          WHERE enabled = 1`
      );
      this._termsCache = rows || [];
      this._termsCacheAt = Date.now();
    } catch (err) {
      console.error('❌ ModerationService: failed to load terms cache:', err.message);
      this._termsCache = [];
    }
  }

  /**
   * Force a cache refresh. Wired in PR-M5 when admin edits trigger this.
   */
  async refreshTermsCache() {
    await this._loadTermsCache();
  }

  /**
   * Late-inject the ActionArbiter. The arbiter depends on
   * RandomStreamRotationService, which is constructed in server/index.js
   * AFTER ModerationService — both the MediaSoup and the LiveKit branches
   * call this setter once their rotation service is wired. Calling more
   * than once is allowed and is treated as a replacement (the most-recent
   * arbiter wins) so a backend that swaps rotation strategies mid-process
   * doesn't end up with a stale arbiter wired to a torn-down rotation
   * service.
   */
  setActionArbiter(arbiter) {
    this.actionArbiter = arbiter || null;
    // Sync enforce state when an arbiter is (re)injected so a late-wired
    // arbiter doesn't operate against a stale flag value.
    if (this.actionArbiter && typeof this.actionArbiter.setEnforce === 'function' && this._enforce !== undefined) {
      this.actionArbiter.setEnforce(this._enforce);
    }
  }

  setStage3(stage3) {
    this.stage3 = stage3 || null;
  }

  // ── Event subscription ─────────────────────────────────────────────────

  _subscribeToTranscriptionChunks() {
    if (this._chunkListener) return;
    this._chunkListener = (chunk) => {
      this.handleTranscriptChunk(chunk).catch((err) => {
        console.error('❌ ModerationService: handleTranscriptChunk error:', err);
      });
    };
    this.transcriptionService.on('transcription-chunk', this._chunkListener);
  }

  _unsubscribeFromTranscriptionChunks() {
    if (this._chunkListener && this.transcriptionService) {
      this.transcriptionService.off('transcription-chunk', this._chunkListener);
      this._chunkListener = null;
    }
  }

  // ── Main pipeline entry point ──────────────────────────────────────────

  /**
   * Process a single transcription-chunk event. Per-streamer mutex ensures
   * chunks for the same streamer run serially; different streamers run
   * concurrently. Exposed for tests + future explicit callers.
   *
   * @param {object} chunk { sessionId, streamerId, chunkNumber, text, ... }
   * @returns {Promise<object|null>} The moderation_events row written, or
   *                                 null if no Stage 1 hit / chunk skipped.
   */
  async handleTranscriptChunk(chunk) {
    if (this._stopped) return null;
    if (!chunk) return null;

    // TranscriptionService emits `transcription-chunk` with TWO different
    // payload shapes depending on which backend produced the audio:
    //   - MediaSoup path (`startTimedTranscription` MediaSoup branch,
    //     TranscriptionService.js around line 1061): `{ ..., text }`.
    //   - LiveKit path (URL-relay streams, line 997): `{ ..., transcription }`.
    // The cross-cutting bug: production URL relays go through LiveKit and
    // therefore emit `{transcription}` — a strict `chunk.text` read would
    // silently drop every URL-relay chunk and leave the relay unmoderated.
    // Read either field and normalize down to a single `text` property so
    // the rest of the pipeline doesn't have to care. The follow-up that
    // unifies the emit shape in TranscriptionService itself is tracked
    // separately (see CHANGELOG for this PR); the defensive read here is
    // load-bearing in the meantime.
    const text = (typeof chunk.text === 'string' && chunk.text)
      || (typeof chunk.transcription === 'string' && chunk.transcription)
      || null;
    if (!text) return null;
    const normalizedChunk = chunk.text === text ? chunk : { ...chunk, text };
    const streamerId = chunk.streamerId || 'unknown';

    const prev = this._streamerChains.get(streamerId) || Promise.resolve();
    const next = prev.then(() => this._processChunk(normalizedChunk).catch((err) => {
      console.error('❌ ModerationService: chunk processing failed:', err);
      return null;
    }));
    this._streamerChains.set(streamerId, next);

    // Lazy chain cleanup: when this chain settles, if it's still the head
    // of the streamer's chain (no later chunk piled on), delete the entry
    // so the map doesn't grow unbounded for transient streamers.
    next.finally(() => {
      if (this._streamerChains.get(streamerId) === next) {
        this._streamerChains.delete(streamerId);
      }
    });

    return next;
  }

  async _processChunk(chunk) {
    const streamerId = chunk.streamerId || 'unknown';

    // Append this chunk to the streamer's rolling context buffer BEFORE
    // matching so the context buffer reflects everything spoken in the
    // window, not just chunks that tripped Stage 1.
    this._pushContext(streamerId, chunk.text);

    // Sliding-overlap Stage 1: concat previous chunk + this chunk so a
    // multi-word phrase that straddles the 5s boundary still matches.
    const previous = this._previousChunkText.get(streamerId) || '';
    const slidingText = previous ? `${previous} ${chunk.text}` : chunk.text;
    this._previousChunkText.set(streamerId, chunk.text);

    const normalized = Stage1.normalize(slidingText);
    if (!normalized) return null;
    const matches = Stage1.findMatches(normalized, this._termsCache);
    if (matches.length === 0) {
      // No Stage 1 hit — no row written, Stage 2/3 don't run.
      return null;
    }

    const streamType = this._resolveStreamType(chunk.streamerId);
    const streamGeneration = this.streamService.getStreamGeneration();
    const matchedTermsJson = JSON.stringify(matches.map((m) => ({
      term: m.term,
      category: m.category,
      severity: m.severity,
    })));
    const surroundingContext = this._buildSurroundingContext(streamerId);

    // Stage 2: structured LLM verdict. Demand-gated on a Stage 1 hit.
    // Skipped if Stage 2 isn't wired (M1 backcompat) or its circuit
    // breaker is open / the GROQ_API_KEY is missing.
    let stage2Result = null;
    if (this.stage2 && this.stage2.isReady()) {
      try {
        stage2Result = await this.stage2.classify({
          transcriptExcerpt: chunk.text,
          surroundingContext,
        });
      } catch (err) {
        console.error('❌ ModerationService: Stage 2 threw:', err);
        stage2Result = { error: 'stage2_threw', raw_status: null, raw_body: null };
      }
    }

    // Stage 2's verdict shape: success → {risk_level, categories,
    // explanation, model, latency_ms, raw}; degraded → {degraded: true,
    // reason}; error → {error, raw_status, raw_body}.
    let finalDecision = 'admin_review';
    let stage2VerdictJson = null;
    let stage2RiskLevel = null;
    let stage2CategoriesJson = null;
    let stage3VerdictJson = null;
    let actionTaken = null;
    const mlModels = { stage1: 'embedded-v1' };

    if (stage2Result) {
      if (stage2Result.degraded) {
        finalDecision = 'deferred_degraded';
        stage2VerdictJson = JSON.stringify({ degraded: true, reason: stage2Result.reason });
      } else if (stage2Result.error) {
        finalDecision = 'deferred_degraded';
        stage2VerdictJson = JSON.stringify({
          error: stage2Result.error,
          raw_status: stage2Result.raw_status || null,
        });
      } else if (Number.isInteger(stage2Result.risk_level)) {
        stage2VerdictJson = JSON.stringify({
          risk_level: stage2Result.risk_level,
          categories: stage2Result.categories,
          explanation: stage2Result.explanation,
          latency_ms: stage2Result.latency_ms,
        });
        stage2RiskLevel = stage2Result.risk_level;
        stage2CategoriesJson = JSON.stringify(stage2Result.categories);
        mlModels.stage2 = stage2Result.model;

        // Stage 3 cross-check: ONLY fires when Stage 2 returned risk_level=3
        // and Stage 3 is wired + ready + the per-streamer quota allows it.
        // Auto-action requires 2-of-2 HIGH agreement (Stage 3 flagged on at
        // least one of the relevant categories). Disagreement downgrades to
        // admin_review per ADR-0013's bias-mitigation requirement.
        if (stage2Result.risk_level === 3) {
          const stage3Result = await this._maybeCallStage3({
            streamerId,
            text: chunk.text,
            surroundingContext,
          });
          if (stage3Result) {
            stage3VerdictJson = JSON.stringify(stage3Result);
            if (stage3Result.degraded) {
              finalDecision = 'deferred_degraded';
            } else if (stage3Result.error) {
              // Stage 3 transport failure on a risk=3 Stage 2 verdict —
              // don't auto-act, route to admin to be safe.
              finalDecision = 'admin_review';
            } else {
              mlModels.stage3 = stage3Result.model;
              if (stage3Result.flagged === true) {
                // Both stages agree: this is the only path that may produce
                // auto_ban / auto_skip. Hand off to the action arbiter,
                // which itself checks AI_MODERATION_ENFORCE and the
                // stale-session invariant.
                if (this.actionArbiter) {
                  const arb = await this.actionArbiter.arbitrate({
                    id: null, // event id not known until after insert; arbiter doesn't need it for the action itself, only logging.
                    stream_session_id: String(streamGeneration),
                    streamer_id: chunk.streamerId || null,
                    stream_type: streamType,
                    external_platform: chunk.externalPlatform || null,
                    external_login: chunk.externalLogin || null,
                    external_user_id: chunk.externalUserId || null,
                  });
                  finalDecision = arb.final_decision;
                  actionTaken = arb.action_taken;
                } else {
                  finalDecision = 'admin_review';
                  actionTaken = 'no_action_arbiter';
                }
              } else {
                // Stage 3 disagrees with Stage 2: 1-of-2 not enough.
                finalDecision = 'admin_review';
                actionTaken = 'stage3_disagreed';
              }
            }
          }
          // else: stage3Result === null means we didn't call it (no
          // wire, not ready, or over quota). final_decision stays at
          // its post-Stage-2 default which is admin_review. We tag the
          // action_taken so admins can see why we didn't escalate.
          if (!stage3Result) {
            actionTaken = actionTaken || 'stage3_not_called';
          }
        }
      }
    }

    const event = await this._insertEvent({
      stream_session_id: String(streamGeneration),
      streamer_id: chunk.streamerId || null,
      stream_type: streamType,
      transcript_chunk_id: chunk.chunkId || null,
      transcript_excerpt: chunk.text,
      surrounding_context: surroundingContext,
      matched_terms_json: matchedTermsJson,
      stage1_hit: 1,
      stage2_verdict_json: stage2VerdictJson,
      stage2_risk_level: stage2RiskLevel,
      stage2_categories_json: stage2CategoriesJson,
      stage3_verdict_json: stage3VerdictJson,
      final_decision: finalDecision,
      action_taken: actionTaken,
      actor: 'system',
      automated_decision: 1,
      legal_basis: null,
      redress_url: null,
      ml_model_versions_json: JSON.stringify(mlModels),
    });

    if (event) {
      this.moderationNotifier.eventCreated({ event });
      this.emit('event-created', event);
    }
    return event;
  }

  /**
   * Call Stage 3 if it's wired, ready, and within the per-streamer hourly
   * quota. Returns the Stage 3 result object or null if skipped.
   */
  async _maybeCallStage3({ streamerId, text, surroundingContext }) {
    if (!this.stage3 || !this.stage3.isReady()) return null;

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    let calls = this._stage3CallsByStreamer.get(streamerId);
    if (!calls) {
      calls = [];
      this._stage3CallsByStreamer.set(streamerId, calls);
    }
    while (calls.length > 0 && calls[0] < oneHourAgo) calls.shift();
    if (calls.length >= this.stage3QuotaPerHour) {
      // Over quota — return a sentinel that ModerationService can treat
      // the same as Stage 3 not being wired: no auto-action, admin_review.
      return null;
    }
    calls.push(now);

    try {
      return await this.stage3.classify({
        text: (surroundingContext ? `${surroundingContext}\n\n` : '') + text,
      });
    } catch (err) {
      console.error('❌ ModerationService: Stage 3 threw:', err);
      return { error: 'stage3_threw', raw_status: null, raw_body: null };
    }
  }

  _pushContext(streamerId, text) {
    const now = Date.now();
    let buf = this._contextBuffers.get(streamerId);
    if (!buf) {
      buf = [];
      this._contextBuffers.set(streamerId, buf);
    }
    buf.push({ text, t: now });
    const cutoff = now - this.contextWindowMs;
    while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
  }

  _buildSurroundingContext(streamerId) {
    const buf = this._contextBuffers.get(streamerId);
    if (!buf || buf.length === 0) return null;
    return buf.map((c) => c.text).join(' ');
  }

  /**
   * Map the live stream state to one of the moderation_events.stream_type
   * enum values.
   *
   * Production observation that drove this rewrite: `ViewBotURLService`
   * calls `streamService.setStreamer(urlId)` for URL-relay sessions WITHOUT
   * a second `streamType` argument. `StreamService.setStreamer` defaults
   * the missing arg to `'webcam'`, so `getStreamType()` reports `'webcam'`
   * for what's actually a URL relay. That mislabels every moderation_events
   * row from a URL-relay session, and — when `AI_MODERATION_ENFORCE=true` —
   * routes the ActionArbiter to `_actWebcam` (which would attempt to ban a
   * `user_id` that doesn't exist for URL relays) instead of `_actUrlRelay`
   * (which adds a `WhitelistService` block entry, the right action).
   *
   * The canonical URL-relay id prefix is `url-stream-` (literal substring
   * used in `ViewBotURLService.js` around `participantIdentity?.startsWith('url-stream-')`
   * and the `url-stream-${Date.now()}-...` mint site). We detect it here
   * to recover the correct `stream_type` without requiring a cross-cutting
   * change to `ViewBotURLService` (which would touch many call sites
   * and could surprise other consumers of `streamService.getStreamType()`).
   *
   * @param {string} [streamerId]  Optional. When provided, takes precedence
   *                               over the streamService value so the prefix
   *                               check works even when `setStreamer` was
   *                               called with the default streamType.
   */
  _resolveStreamType(streamerId) {
    if (typeof streamerId === 'string' && streamerId.startsWith('url-stream-')) {
      return 'url-relay';
    }
    const t = this.streamService.getStreamType();
    if (t === 'viewbot' || t === 'webrtc-viewbot') return 'viewbot';
    if (t === 'url-relay') return 'url-relay';
    return 'webcam';
  }

  async _insertEvent(row) {
    try {
      const result = await this.database.runAsync(
        `INSERT INTO moderation_events
            (stream_session_id, streamer_id, stream_type,
             transcript_chunk_id, transcript_excerpt, surrounding_context,
             matched_terms_json, stage1_hit,
             stage2_verdict_json, stage2_risk_level, stage2_categories_json,
             stage3_verdict_json,
             final_decision, action_taken, actor,
             automated_decision, legal_basis, redress_url,
             ml_model_versions_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.stream_session_id,
          row.streamer_id,
          row.stream_type,
          row.transcript_chunk_id,
          row.transcript_excerpt,
          row.surrounding_context,
          row.matched_terms_json,
          row.stage1_hit,
          row.stage2_verdict_json || null,
          row.stage2_risk_level == null ? null : row.stage2_risk_level,
          row.stage2_categories_json || null,
          row.stage3_verdict_json || null,
          row.final_decision,
          row.action_taken,
          row.actor,
          row.automated_decision,
          row.legal_basis,
          row.redress_url,
          row.ml_model_versions_json,
        ]
      );
      const id = result && result.id;
      if (!id) return null;
      // Return enough of the row for the notifier + admin UI to render
      // without a re-fetch. Full row also available via getEvent(id).
      return {
        id,
        stream_session_id: row.stream_session_id,
        streamer_id: row.streamer_id,
        stream_type: row.stream_type,
        transcript_excerpt: row.transcript_excerpt,
        matched_terms_json: row.matched_terms_json,
        stage2_verdict_json: row.stage2_verdict_json || null,
        stage2_risk_level: row.stage2_risk_level == null ? null : row.stage2_risk_level,
        stage2_categories_json: row.stage2_categories_json || null,
        stage3_verdict_json: row.stage3_verdict_json || null,
        final_decision: row.final_decision,
        action_taken: row.action_taken,
        actor: row.actor,
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      console.error('❌ ModerationService: failed to insert moderation_events row:', err.message);
      return null;
    }
  }

  // ── MovieBot output gate (PR-M4) ───────────────────────────────────────

  /**
   * Stage-1 + Stage-2 gate for outbound MovieBot chat replies. Called by
   * MovieBotService just before it emits a generated response. Runs the
   * same word-filter + LLM classifier as the streamer-audio pipeline, but
   * with three differences:
   *   1. NO Stage 3 cross-check — bot output is dropped silently per the
   *      user's choice (M0 decision matrix), so the cross-check has nothing
   *      to gate. Cheaper, faster.
   *   2. NO ActionArbiter — drop is the only action.
   *   3. Stream-type is 'moviebot-output' so admin events tab can filter.
   *
   * @param {string} text                 The generated bot reply.
   * @param {object} [ctx]
   * @param {string} [ctx.streamerId]     Current streamer's socket id (context).
   * @param {string} [ctx.botUsername]    Bot persona id (admin diagnostics).
   * @returns {Promise<{allowed: boolean, reason?: string, eventId?: number}>}
   */
  async checkBotOutput(text, ctx = {}) {
    if (this._stopped) return { allowed: true };
    if (typeof text !== 'string' || text.length === 0) return { allowed: true };

    const normalized = Stage1.normalize(text);
    const matches = Stage1.findMatches(normalized, this._termsCache);

    let stage2VerdictJson = null;
    let stage2RiskLevel = null;
    let stage2CategoriesJson = null;
    let stage2Said = null;
    if (matches.length > 0 && this.stage2 && this.stage2.isReady()) {
      try {
        const r = await this.stage2.classify({ transcriptExcerpt: text });
        if (r) {
          if (r.degraded) {
            stage2VerdictJson = JSON.stringify({ degraded: true, reason: r.reason });
          } else if (r.error) {
            stage2VerdictJson = JSON.stringify({ error: r.error });
          } else if (Number.isInteger(r.risk_level)) {
            stage2Said = r;
            stage2VerdictJson = JSON.stringify({
              risk_level: r.risk_level,
              categories: r.categories,
              explanation: r.explanation,
              latency_ms: r.latency_ms,
            });
            stage2RiskLevel = r.risk_level;
            stage2CategoriesJson = JSON.stringify(r.categories);
          }
        }
      } catch (err) {
        console.error('❌ ModerationService: checkBotOutput Stage 2 threw:', err);
      }
    }

    // Decision: drop if Stage 1 matched a hard-tier term OR Stage 2 returned
    // risk_level >= 2. The threshold here is lower than the streamer-audio
    // pipeline (which only acts on risk_level=3 + 2-of-2) because bot output
    // is a controlled surface — we'd rather drop a borderline reply than
    // emit it under the platform's identity.
    const hardHit = matches.some((m) => m.severity === 'hard');
    const stage2Hit = stage2Said && stage2Said.risk_level >= 2;
    const shouldDrop = matches.length > 0 && (hardHit || stage2Hit);

    if (!shouldDrop) {
      return { allowed: true };
    }

    const event = await this._insertEvent({
      stream_session_id: String(this.streamService.getStreamGeneration()),
      streamer_id: ctx.streamerId || null,
      stream_type: 'moviebot-output',
      transcript_chunk_id: null,
      transcript_excerpt: text,
      surrounding_context: ctx.botUsername ? `bot=${ctx.botUsername}` : null,
      matched_terms_json: JSON.stringify(matches.map((m) => ({
        term: m.term, category: m.category, severity: m.severity,
      }))),
      stage1_hit: matches.length > 0 ? 1 : 0,
      stage2_verdict_json: stage2VerdictJson,
      stage2_risk_level: stage2RiskLevel,
      stage2_categories_json: stage2CategoriesJson,
      final_decision: 'mb_output_dropped',
      action_taken: hardHit ? 'dropped_hard_tier_word' : 'dropped_stage2_risk',
      actor: 'system',
      automated_decision: 1,
      legal_basis: null,
      redress_url: null,
      ml_model_versions_json: JSON.stringify({
        stage1: 'embedded-v1',
        stage2: stage2Said && stage2Said.model || null,
      }),
    });

    if (event) {
      this.moderationNotifier.botOutputDropped({ event });
      this.emit('bot-output-dropped', event);
    }
    return {
      allowed: false,
      reason: hardHit ? 'hard_tier_word' : 'stage2_risk',
      eventId: event && event.id,
    };
  }

  // ── Read API for admin (PR-M5 will use these via routes) ──────────────

  async getEvent(id) {
    return this.database.getAsync(
      `SELECT * FROM moderation_events WHERE id = ?`,
      [id]
    );
  }

  async getEvents({ limit = 50, offset = 0, decision = null } = {}) {
    let sql = `SELECT * FROM moderation_events`;
    const params = [];
    if (decision) {
      sql += ` WHERE final_decision = ?`;
      params.push(decision);
    }
    // Secondary sort by id DESC because SQLite's CURRENT_TIMESTAMP has
    // only 1-second resolution; without the id tiebreak, two rows inserted
    // in the same second can return in non-deterministic order.
    sql += ` ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    params.push(Math.min(Number(limit) || 50, 500), Number(offset) || 0);
    return this.database.allAsync(sql, params);
  }

  getTermsCacheSnapshot() {
    return this._termsCache.slice();
  }

  /**
   * Mark an event as reversed by an admin. If the event was an `auto_ban`,
   * also unbans the user — `users.streaming_banned = 0` + clears the
   * banned-at / banned-by fields. URL-relay reversal removes the
   * blocklist row (admin's responsibility to call via WhitelistService;
   * we just mark the event reversed).
   *
   * Side-effects on the user record happen via the `userRepository` dep
   * which is OPTIONAL on ModerationService — passing it via the
   * actionArbiter is the canonical path because the arbiter already
   * holds the dep. Routes use the arbiter's userRepository to perform
   * the unban; this method only writes the moderation_events row.
   *
   * @param {number} eventId
   * @param {string} adminId   actor token (e.g., admin username).
   * @param {string} reason    free-form reversal note.
   */
  async reverseEvent(eventId, adminId, reason) {
    const row = await this.getEvent(eventId);
    if (!row) return { ok: false, error: 'event_not_found' };
    if (row.reversed_at) return { ok: false, error: 'already_reversed' };
    await this.database.runAsync(
      `UPDATE moderation_events
          SET reversed_at = CURRENT_TIMESTAMP, reversed_by = ?, reversal_reason = ?
        WHERE id = ?`,
      [adminId, reason || null, eventId]
    );
    return { ok: true, event_id: eventId };
  }

  // ── Terms CRUD ─────────────────────────────────────────────────────────

  async getTerms({ enabled = null, category = null, source = null } = {}) {
    const where = [];
    const params = [];
    if (enabled !== null) { where.push('enabled = ?'); params.push(enabled ? 1 : 0); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (source) { where.push('source = ?'); params.push(source); }
    let sql = 'SELECT * FROM moderation_terms';
    if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
    sql += ' ORDER BY category, severity, normalized_form';
    return this.database.allAsync(sql, params);
  }

  async addTerm({ term, category, severity = 'soft', notes = null }, adminId) {
    if (!term || typeof term !== 'string') throw new Error('term required');
    if (!['hate_speech', 'threat', 'sexual'].includes(category)) throw new Error('invalid category');
    if (!['hard', 'soft'].includes(severity)) throw new Error('invalid severity');
    const normalized = Stage1.normalize(term);
    if (!normalized) throw new Error('term normalizes to empty string');

    const result = await this.database.runAsync(
      `INSERT INTO moderation_terms
          (term, normalized_form, category, severity, source, enabled, created_by, notes)
        VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)`,
      [term, normalized, category, severity, adminId || null, notes]
    );
    const id = result && result.id;
    await this._auditTerm({ actor: adminId, action: 'add', term_id: id, after: { term, normalized_form: normalized, category, severity, notes } });
    await this._loadTermsCache();
    return { id, normalized_form: normalized };
  }

  async setTermEnabled(id, enabled, adminId) {
    const before = await this.database.getAsync('SELECT * FROM moderation_terms WHERE id = ?', [id]);
    if (!before) return { ok: false, error: 'not_found' };
    if (before.source === 'embedded' && enabled === false) {
      // Embedded rows can be soft-disabled, but they're re-enabled on the
      // next boot (the seed wins). Log it loudly so the admin understands
      // the durability semantics.
      console.warn(`⚠️ ModerationService: admin disabled embedded term id=${id} ("${before.term}") — will be re-enabled on next boot`);
    }
    await this.database.runAsync(
      'UPDATE moderation_terms SET enabled = ? WHERE id = ?',
      [enabled ? 1 : 0, id]
    );
    await this._auditTerm({ actor: adminId, action: enabled ? 'enable' : 'disable', term_id: id, before, after: { ...before, enabled: enabled ? 1 : 0 } });
    await this._loadTermsCache();
    return { ok: true, id };
  }

  async removeTerm(id, adminId) {
    const before = await this.database.getAsync('SELECT * FROM moderation_terms WHERE id = ?', [id]);
    if (!before) return { ok: false, error: 'not_found' };
    if (before.source === 'embedded') {
      return { ok: false, error: 'cannot_remove_embedded' };
    }
    await this.database.runAsync('DELETE FROM moderation_terms WHERE id = ?', [id]);
    await this._auditTerm({ actor: adminId, action: 'remove', term_id: id, before });
    await this._loadTermsCache();
    return { ok: true, id };
  }

  async _auditTerm({ actor, action, term_id, before = null, after = null }) {
    // Hash-chain wiring is M6 — for now we store the rows with empty
    // prev_hash/row_hash and PR-M6 will backfill once a hash function is
    // chosen. The audit row itself is already useful for the events tab.
    await this.database.runAsync(
      `INSERT INTO moderation_terms_audit (actor, action, term_id, before_json, after_json)
       VALUES (?, ?, ?, ?, ?)`,
      [actor || null, action, term_id, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
    );
  }

  async getTermsAudit({ limit = 50 } = {}) {
    return this.database.allAsync(
      'SELECT * FROM moderation_terms_audit ORDER BY at DESC, id DESC LIMIT ?',
      [Math.min(Number(limit) || 50, 500)]
    );
  }

  // ── Config CRUD ────────────────────────────────────────────────────────

  async getCategoryConfig() {
    return this.database.allAsync('SELECT * FROM moderation_config ORDER BY category');
  }

  // ── Retention (PR-M6) ──────────────────────────────────────────────────

  /**
   * Purge moderation_events rows older than the configured retention
   * windows: 90 days for non-clean decisions (kept to cover the appeal
   * window + DSA Article 17 statement-of-reasons accessibility), 30 days
   * for `final_decision='clean'` rows (which we don't write today —
   * PR-M1 only writes on Stage 1 hits — but the constraint is kept so the
   * window applies cleanly if a future PR starts logging clean
   * classifications). Returns counts so the scheduler can log.
   *
   * @param {object} [opts]
   * @param {number} [opts.flaggedRetentionDays=90]
   * @param {number} [opts.cleanRetentionDays=30]
   */
  async purgeOldEvents({ flaggedRetentionDays = 90, cleanRetentionDays = 30 } = {}) {
    const flaggedCutoff = `-${Math.max(1, flaggedRetentionDays)} days`;
    const cleanCutoff = `-${Math.max(1, cleanRetentionDays)} days`;

    let flaggedDeleted = 0;
    let cleanDeleted = 0;
    try {
      const r = await this.database.runAsync(
        `DELETE FROM moderation_events
          WHERE final_decision <> 'clean'
            AND created_at < datetime('now', ?)`,
        [flaggedCutoff]
      );
      flaggedDeleted = (r && r.changes) || 0;
    } catch (err) {
      console.error('❌ ModerationService.purgeOldEvents (flagged) failed:', err.message);
    }
    try {
      const r = await this.database.runAsync(
        `DELETE FROM moderation_events
          WHERE final_decision = 'clean'
            AND created_at < datetime('now', ?)`,
        [cleanCutoff]
      );
      cleanDeleted = (r && r.changes) || 0;
    } catch (err) {
      console.error('❌ ModerationService.purgeOldEvents (clean) failed:', err.message);
    }
    if (flaggedDeleted > 0 || cleanDeleted > 0) {
      console.log(`🧹 ModerationService: purged ${flaggedDeleted} flagged + ${cleanDeleted} clean moderation_events rows`);
    }
    return { flaggedDeleted, cleanDeleted };
  }

  /**
   * Start the daily retention scheduler. setInterval-driven; the handle
   * is unref'd so it doesn't keep the process alive on shutdown.
   * `stop()` clears it.
   */
  startRetentionScheduler(opts = {}) {
    const interval = opts.intervalMs || 24 * 60 * 60 * 1000; // 24h
    if (this._retentionTimer) return; // idempotent
    // Kick off the first run after a 60s grace period so we don't compete
    // with other boot-time IO.
    this._retentionFirstRun = setTimeout(() => {
      this.purgeOldEvents(opts).catch((err) => console.error('retention first run:', err));
    }, 60_000);
    if (typeof this._retentionFirstRun.unref === 'function') this._retentionFirstRun.unref();
    this._retentionTimer = setInterval(() => {
      this.purgeOldEvents(opts).catch((err) => console.error('retention tick:', err));
    }, interval);
    if (typeof this._retentionTimer.unref === 'function') this._retentionTimer.unref();
  }

  // ── Config ──────────────────────────────────────────────────────────────

  async setCategoryConfig({ category, action_mode, stage2_threshold, stage3_required, enabled }, adminId) {
    if (!['hate_speech', 'threat', 'sexual'].includes(category)) throw new Error('invalid category');
    const fields = [];
    const params = [];
    if (action_mode !== undefined) {
      if (!['auto_ban', 'admin_review', 'mute_pending'].includes(action_mode)) throw new Error('invalid action_mode');
      fields.push('action_mode = ?'); params.push(action_mode);
    }
    if (stage2_threshold !== undefined) {
      const t = Number(stage2_threshold);
      if (!Number.isInteger(t) || t < 0 || t > 3) throw new Error('invalid stage2_threshold');
      fields.push('stage2_threshold = ?'); params.push(t);
    }
    if (stage3_required !== undefined) {
      fields.push('stage3_required = ?'); params.push(stage3_required ? 1 : 0);
    }
    if (enabled !== undefined) {
      fields.push('enabled = ?'); params.push(enabled ? 1 : 0);
    }
    if (fields.length === 0) return { ok: false, error: 'no_fields' };
    fields.push('updated_at = CURRENT_TIMESTAMP');
    fields.push('updated_by = ?'); params.push(adminId || null);
    params.push(category);
    await this.database.runAsync(
      `UPDATE moderation_config SET ${fields.join(', ')} WHERE category = ?`,
      params
    );
    return { ok: true, category };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async stop() {
    this._stopped = true;
    this._unsubscribeFromTranscriptionChunks();
    if (this._retentionTimer) {
      clearInterval(this._retentionTimer);
      this._retentionTimer = null;
    }
    if (this._retentionFirstRun) {
      clearTimeout(this._retentionFirstRun);
      this._retentionFirstRun = null;
    }
    // Drain any in-flight per-streamer chains.
    const chains = Array.from(this._streamerChains.values());
    await Promise.allSettled(chains);
    this._streamerChains.clear();
    this._contextBuffers.clear();
    this._previousChunkText.clear();
  }
}

module.exports = ModerationService;
