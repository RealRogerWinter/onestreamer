-- Recording System Database Schema
-- Creates tables for managing recording sessions and events

-- Main recordings table
CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    stream_id TEXT NOT NULL,
    streamer_id TEXT NOT NULL,
    start_time DATETIME NOT NULL,
    end_time DATETIME,
    duration INTEGER, -- duration in seconds
    file_path TEXT,
    file_size INTEGER, -- file size in bytes
    quality_profile TEXT DEFAULT '720p', -- '720p', '1080p', '480p'
    format TEXT DEFAULT 'webm', -- 'webm', 'mp4'
    status TEXT DEFAULT 'recording', -- 'recording', 'processing', 'completed', 'failed', 'archived'
    compression_status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    thumbnail_path TEXT,
    metadata_json TEXT, -- JSON string for additional metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
CREATE INDEX IF NOT EXISTS idx_recordings_streamer_id ON recordings(streamer_id);
CREATE INDEX IF NOT EXISTS idx_recordings_created_at ON recordings(created_at);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
CREATE INDEX IF NOT EXISTS idx_recordings_quality_profile ON recordings(quality_profile);
CREATE INDEX IF NOT EXISTS idx_recording_events_recording_id ON recording_events(recording_id);
CREATE INDEX IF NOT EXISTS idx_recording_events_timestamp ON recording_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_recording_events_event_type ON recording_events(event_type);

-- Create trigger to update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_recordings_timestamp 
    AFTER UPDATE ON recordings
    FOR EACH ROW
BEGIN
    UPDATE recordings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;