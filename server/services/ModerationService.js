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
    this._subscribeToTranscriptionChunks();

    this.initialized = true;
    console.log(`✅ ModerationService initialized (terms=${this._termsCache.length})`);
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
    if (!chunk || typeof chunk.text !== 'string' || chunk.text.length === 0) return null;
    const streamerId = chunk.streamerId || 'unknown';

    const prev = this._streamerChains.get(streamerId) || Promise.resolve();
    const next = prev.then(() => this._processChunk(chunk).catch((err) => {
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

    const streamType = this._resolveStreamType();
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
   * enum values. PR-M3 will refine 'webcam' vs 'url-relay' by consulting
   * viewBotURLService; for M1 we use what streamService says and default
   * to 'webcam' for anything we don't recognize.
   */
  _resolveStreamType() {
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

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async stop() {
    this._stopped = true;
    this._unsubscribeFromTranscriptionChunks();
    // Drain any in-flight per-streamer chains.
    const chains = Array.from(this._streamerChains.values());
    await Promise.allSettled(chains);
    this._streamerChains.clear();
    this._contextBuffers.clear();
    this._previousChunkText.clear();
  }
}

module.exports = ModerationService;
