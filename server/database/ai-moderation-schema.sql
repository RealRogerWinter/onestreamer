-- AI Moderation Schema
-- Three-stage pipeline (word filter → Groq classifier → OpenAI omni cross-check)
-- subscribing to transcription-chunk events and acting on hate-speech, threat,
-- and sexual/CSAM-adjacent content. See docs/architecture/adr/0013-ai-moderation-pipeline.md.

-- Embedded + admin-editable word list. source='embedded' rows come from the
-- signed seed file at server/data/seeds/moderation-core-list.json and are
-- restored on every boot. Admins can disable them via 'enabled=0' but cannot
-- delete them from the table.
CREATE TABLE IF NOT EXISTS moderation_terms (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    term            TEXT NOT NULL,
    normalized_form TEXT NOT NULL,
    category        TEXT NOT NULL CHECK (category IN ('hate_speech', 'threat', 'sexual')),
    severity        TEXT NOT NULL CHECK (severity IN ('hard', 'soft')) DEFAULT 'hard',
    source          TEXT NOT NULL CHECK (source IN ('embedded', 'admin')) DEFAULT 'admin',
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_by      TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes           TEXT,
    UNIQUE (normalized_form, category)
);

CREATE INDEX IF NOT EXISTS idx_moderation_terms_norm ON moderation_terms(normalized_form);
CREATE INDEX IF NOT EXISTS idx_moderation_terms_enabled ON moderation_terms(enabled, severity);

-- Append-only audit log for moderation_terms mutations. Hash-chained for
-- tamper evidence (prev_hash references the previous row's row_hash).
CREATE TABLE IF NOT EXISTS moderation_terms_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor       TEXT,
    action      TEXT NOT NULL CHECK (action IN ('add', 'edit', 'disable', 'enable', 'remove')),
    term_id     INTEGER,
    before_json TEXT,
    after_json  TEXT,
    prev_hash   TEXT,
    row_hash    TEXT
);

CREATE INDEX IF NOT EXISTS idx_moderation_terms_audit_at ON moderation_terms_audit(at);

-- One row per moderation decision. Carries the full statement-of-reasons
-- required by DSA Article 17 plus the stale-session check key
-- (stream_session_id) used to ignore verdicts that arrive after rotation.
CREATE TABLE IF NOT EXISTS moderation_events (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at              DATETIME DEFAULT CURRENT_TIMESTAMP,

    stream_session_id       TEXT,
    streamer_id             TEXT,
    stream_type             TEXT NOT NULL CHECK (stream_type IN ('webcam', 'viewbot', 'url-relay', 'moviebot-output')),
    external_platform       TEXT CHECK (external_platform IN ('twitch', 'kick') OR external_platform IS NULL),
    external_user_id        TEXT,
    external_login          TEXT,

    transcript_chunk_id     INTEGER,
    transcript_excerpt      TEXT NOT NULL,
    surrounding_context     TEXT,

    matched_terms_json      TEXT,
    stage1_hit              INTEGER NOT NULL DEFAULT 0,
    stage2_verdict_json     TEXT,
    stage2_risk_level       INTEGER,
    stage2_categories_json  TEXT,
    stage3_verdict_json     TEXT,

    final_decision          TEXT NOT NULL CHECK (final_decision IN (
        'clean', 'admin_review', 'auto_ban', 'auto_skip',
        'mb_output_dropped', 'deferred_degraded'
    )),
    action_taken            TEXT,
    actor                   TEXT NOT NULL DEFAULT 'system',

    -- DSA Article 17 statement-of-reasons fields.
    automated_decision      INTEGER NOT NULL DEFAULT 1,
    legal_basis             TEXT,
    redress_url             TEXT,
    human_reviewed_at       DATETIME,
    human_reviewer_id       TEXT,
    reversed_at             DATETIME,
    reversed_by             TEXT,
    reversal_reason         TEXT,

    -- Whisper confidence values (PR-M4 wires these).
    whisper_avg_logprob     REAL,
    whisper_no_speech_prob  REAL,

    -- Model identifiers for reproducibility / regression analysis.
    ml_model_versions_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_modevents_streamer
    ON moderation_events(streamer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_modevents_decision
    ON moderation_events(final_decision, created_at);
CREATE INDEX IF NOT EXISTS idx_modevents_extid
    ON moderation_events(external_platform, external_user_id);
CREATE INDEX IF NOT EXISTS idx_modevents_session
    ON moderation_events(stream_session_id);
CREATE INDEX IF NOT EXISTS idx_modevents_reversed
    ON moderation_events(reversed_at) WHERE reversed_at IS NOT NULL;

-- Per-category dial. Lets ops drop a category from 'auto_ban' to
-- 'admin_review' without a deploy. Stage2/Stage3 thresholds are configurable
-- so the AAVE-FP-mitigation knobs can be turned without code.
CREATE TABLE IF NOT EXISTS moderation_config (
    category            TEXT PRIMARY KEY CHECK (category IN ('hate_speech', 'threat', 'sexual')),
    enabled             INTEGER NOT NULL DEFAULT 1,
    action_mode         TEXT NOT NULL CHECK (action_mode IN ('auto_ban', 'admin_review', 'mute_pending')) DEFAULT 'auto_ban',
    stage2_threshold    INTEGER NOT NULL DEFAULT 3,
    stage3_required     INTEGER NOT NULL DEFAULT 1,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by          TEXT
);

-- Seed the three categories on first apply. Idempotent.
INSERT OR IGNORE INTO moderation_config (category, action_mode, stage2_threshold, stage3_required)
    VALUES ('hate_speech', 'auto_ban', 3, 1);
INSERT OR IGNORE INTO moderation_config (category, action_mode, stage2_threshold, stage3_required)
    VALUES ('threat',       'auto_ban', 3, 1);
INSERT OR IGNORE INTO moderation_config (category, action_mode, stage2_threshold, stage3_required)
    VALUES ('sexual',       'auto_ban', 3, 1);

-- Singleton global config. One row, id=1, enforced by the CHECK constraint.
-- `enforce`: 1 = ActionArbiter applies real bans + URL-relay blocklists on a
-- confirmed 2-of-2 HIGH agreement; 0 = arbiter downgrades every verdict to
-- 'admin_review' (so events still log + notifier emits, but no destructive
-- actions). Replaces the boot-time-only AI_MODERATION_ENFORCE env flag with
-- a runtime-mutable DB-backed value an admin can flip from the admin UI
-- without a restart. The env flag is still honored ONCE at first install
-- (when no row exists yet) so existing operator-set values aren't ignored
-- on upgrade.
CREATE TABLE IF NOT EXISTS moderation_global_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    enforce     INTEGER NOT NULL DEFAULT 0,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by  TEXT
);
-- Seed only if the row doesn't exist. The env-fallback runs in
-- ModerationService.initialize() AFTER this seed — if the env says enforce=true
-- AND no row exists yet, initialize() upgrades the row. Idempotent.
INSERT OR IGNORE INTO moderation_global_config (id, enforce, updated_by)
    VALUES (1, 0, 'seed');
