-- URL Relay Whitelist Schema
-- Per-platform content filter (off / blacklist / whitelist) for the URL relay subsystem.
-- See docs/architecture/adr/0010-url-relay-whitelist-mode.md for the design.

-- One row per platform. Mode + fallback choices.
-- preferred_languages is a JSON-encoded ISO-639-1 array (e.g. '["en"]').
-- Empty array '[]' disables the language gate for that platform.
CREATE TABLE IF NOT EXISTS url_relay_filter_config (
    platform            TEXT PRIMARY KEY CHECK (platform IN ('twitch', 'kick')),
    mode                TEXT NOT NULL CHECK (mode IN ('off', 'blacklist', 'whitelist')) DEFAULT 'off',
    fallback_category   TEXT,
    fallback_evergreen  TEXT,
    drift_check_seconds INTEGER NOT NULL DEFAULT 60,
    preferred_languages TEXT NOT NULL DEFAULT '["en"]',
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by          TEXT
);

-- Allow/block entries (streamer logins or category names).
CREATE TABLE IF NOT EXISTS url_relay_filter_entries (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    platform          TEXT NOT NULL CHECK (platform IN ('twitch', 'kick')),
    entry_type        TEXT NOT NULL CHECK (entry_type IN ('streamer', 'category')),
    value             TEXT NOT NULL,
    list              TEXT NOT NULL CHECK (list IN ('allow', 'block')),
    is_evergreen      INTEGER NOT NULL DEFAULT 0,
    risk_flag         TEXT,
    notes             TEXT,
    source            TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by        TEXT,
    last_reviewed_at  DATETIME,
    UNIQUE (platform, entry_type, value, list)
);

CREATE INDEX IF NOT EXISTS idx_filter_entries_lookup
    ON url_relay_filter_entries(platform, entry_type, list, value);

CREATE INDEX IF NOT EXISTS idx_filter_entries_evergreen
    ON url_relay_filter_entries(platform, is_evergreen)
    WHERE is_evergreen = 1;

-- Append-only audit log.
CREATE TABLE IF NOT EXISTS url_relay_filter_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor       TEXT,
    action      TEXT NOT NULL,
    platform    TEXT,
    entry_type  TEXT,
    value       TEXT,
    before_json TEXT,
    after_json  TEXT,
    context     TEXT
);

CREATE INDEX IF NOT EXISTS idx_filter_audit_at ON url_relay_filter_audit(at);
CREATE INDEX IF NOT EXISTS idx_filter_audit_action ON url_relay_filter_audit(action);
