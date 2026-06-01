-- Recording System Database Schema
-- Creates tables for managing recording sessions and events
--
-- NOTE: the `recordings` table itself is owned by server/database/database.js
-- (the single source of truth — it runs first at boot, with a DIFFERENT shape:
-- recording_id / quality / is_continuous). The old CREATE TABLE here used a
-- conflicting shape (TEXT id, streamer_id, quality_profile, ...) and was a
-- guaranteed silent no-op on any DB database.js had already touched, so it has
-- been removed (along with its update_recordings_timestamp trigger and the
-- recordings-specific indexes). This file remains the boot-time creator of
-- recording_events + recording_settings, both loaded via
-- server/migrations/setup-recording-tables.js from server/index.js.

-- Recording events table for audit trail
CREATE TABLE IF NOT EXISTS recording_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recording_id TEXT NOT NULL,
    event_type TEXT NOT NULL, -- 'started', 'stopped', 'compressed', 'downloaded', 'deleted', 'error'
    event_data TEXT, -- JSON string with event details
    user_id TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recording_id) REFERENCES recordings (id) ON DELETE CASCADE
);

-- Recording settings table for system configuration
CREATE TABLE IF NOT EXISTS recording_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default recording settings
-- NOTE: recording_settings.retention_days ('30') is a SEPARATE key from
-- admin_review_settings.retention_days ('7' in database.js); they configure
-- different subsystems (legacy recording auto-cleanup vs admin B2 review), so
-- there is nothing to reconcile.
INSERT OR IGNORE INTO recording_settings (key, value, description) VALUES
('max_concurrent_recordings', '3', 'Maximum number of concurrent recordings allowed'),
('max_recording_duration', '3600000', 'Maximum recording duration in milliseconds (1 hour)'),
('disk_space_threshold', '0.85', 'Disk space usage threshold (85%)'),
('compression_queue_limit', '10', 'Maximum number of recordings in compression queue'),
('default_quality', '720p', 'Default recording quality profile'),
('auto_cleanup_enabled', 'true', 'Enable automatic cleanup of old recordings'),
('retention_days', '30', 'Number of days to keep recordings before auto-cleanup'),
('compression_enabled', 'true', 'Enable post-recording compression'),
('thumbnail_generation', 'true', 'Enable thumbnail generation for recordings');

-- Indexes for better query performance
-- (recordings-table indexes live in database.js alongside the table; only the
-- recording_events indexes belong here.)
CREATE INDEX IF NOT EXISTS idx_recording_events_recording_id ON recording_events(recording_id);
CREATE INDEX IF NOT EXISTS idx_recording_events_timestamp ON recording_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_recording_events_event_type ON recording_events(event_type);