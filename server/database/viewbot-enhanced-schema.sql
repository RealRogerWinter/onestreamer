-- Enhanced ViewBot Schema for new features
-- Run this after the base viewbot-schema.sql

-- Add new columns to viewbots table if they don't exist
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS tags TEXT; -- JSON array of tags
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS quality TEXT DEFAULT 'medium' CHECK(quality IN ('low', 'medium', 'high', 'custom'));
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS volume INTEGER DEFAULT 50 CHECK(volume >= 0 AND volume <= 100);
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS ffmpeg_params TEXT;
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS stream_name TEXT;
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS viewer_name TEXT;
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS connection_type TEXT DEFAULT 'WebRTC';
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS is_audio_enabled BOOLEAN DEFAULT 1;
ALTER TABLE viewbots ADD COLUMN IF NOT EXISTS content_url TEXT;

-- ViewBot Templates table
-- Store reusable ViewBot configurations
CREATE TABLE IF NOT EXISTS viewbot_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    config TEXT NOT NULL, -- JSON configuration
    tags TEXT, -- JSON array of tags
    quality TEXT DEFAULT 'medium',
    volume INTEGER DEFAULT 50,
    ffmpeg_params TEXT,
    connection_type TEXT DEFAULT 'WebRTC',
    is_audio_enabled BOOLEAN DEFAULT 1,
    usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ViewBot Schedules table
-- For automated start/stop scheduling
CREATE TABLE IF NOT EXISTS viewbot_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewbot_id INTEGER NOT NULL,
    schedule_type TEXT NOT NULL CHECK(schedule_type IN ('once', 'daily', 'weekly', 'custom')),
    start_time TIME,
    end_time TIME,
    days_of_week TEXT, -- JSON array of day numbers (0-6)
    cron_expression TEXT, -- For custom schedules
    is_active BOOLEAN DEFAULT 1,
    last_run DATETIME,
    next_run DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE
);

-- ViewBot Groups table
-- For organizing ViewBots into logical groups
CREATE TABLE IF NOT EXISTS viewbot_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    color TEXT, -- Hex color for UI
    icon TEXT, -- Icon identifier for UI
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ViewBot Group Members table
-- Many-to-many relationship between viewbots and groups
CREATE TABLE IF NOT EXISTS viewbot_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    viewbot_id INTEGER NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES viewbot_groups (id) ON DELETE CASCADE,
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE,
    UNIQUE(group_id, viewbot_id)
);

-- ViewBot Presets table
-- Quick configuration presets
CREATE TABLE IF NOT EXISTS viewbot_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    preset_type TEXT NOT NULL CHECK(preset_type IN ('quality', 'content', 'full')),
    config TEXT NOT NULL, -- JSON configuration
    is_default BOOLEAN DEFAULT 0,
    usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ViewBot Real-time Metrics table
-- For storing real-time performance data
CREATE TABLE IF NOT EXISTS viewbot_realtime_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewbot_id INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    fps REAL,
    bitrate REAL,
    packet_loss REAL,
    latency REAL,
    bandwidth REAL,
    cpu_usage REAL,
    memory_usage REAL,
    frames_sent INTEGER,
    packets_sent INTEGER,
    packets_lost INTEGER,
    bytes_sent INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE
);

-- ViewBot Alerts table
-- For tracking issues and alerts
CREATE TABLE IF NOT EXISTS viewbot_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewbot_id INTEGER,
    bot_id TEXT,
    alert_type TEXT NOT NULL CHECK(alert_type IN ('error', 'warning', 'info')),
    alert_category TEXT NOT NULL CHECK(alert_category IN ('connection', 'performance', 'quality', 'system')),
    message TEXT NOT NULL,
    details TEXT, -- JSON with additional details
    is_resolved BOOLEAN DEFAULT 0,
    resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE
);

-- Create indexes for enhanced queries
CREATE INDEX IF NOT EXISTS idx_viewbots_tags ON viewbots(tags);
CREATE INDEX IF NOT EXISTS idx_viewbots_quality ON viewbots(quality);
CREATE INDEX IF NOT EXISTS idx_viewbots_stream_name ON viewbots(stream_name);

CREATE INDEX IF NOT EXISTS idx_viewbot_templates_name ON viewbot_templates(name);
CREATE INDEX IF NOT EXISTS idx_viewbot_templates_type ON viewbot_templates(preset_type);

CREATE INDEX IF NOT EXISTS idx_viewbot_schedules_viewbot ON viewbot_schedules(viewbot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_schedules_active ON viewbot_schedules(is_active);
CREATE INDEX IF NOT EXISTS idx_viewbot_schedules_next_run ON viewbot_schedules(next_run);

CREATE INDEX IF NOT EXISTS idx_viewbot_groups_active ON viewbot_groups(is_active);

CREATE INDEX IF NOT EXISTS idx_viewbot_group_members_group ON viewbot_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_group_members_viewbot ON viewbot_group_members(viewbot_id);

CREATE INDEX IF NOT EXISTS idx_viewbot_realtime_metrics_viewbot ON viewbot_realtime_metrics(viewbot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_realtime_metrics_timestamp ON viewbot_realtime_metrics(timestamp);

CREATE INDEX IF NOT EXISTS idx_viewbot_alerts_viewbot ON viewbot_alerts(viewbot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_alerts_type ON viewbot_alerts(alert_type);
CREATE INDEX IF NOT EXISTS idx_viewbot_alerts_resolved ON viewbot_alerts(is_resolved);

-- Insert default presets
INSERT OR IGNORE INTO viewbot_presets (name, description, preset_type, config, is_default) VALUES
('Low Quality', 'Low bandwidth, 480p streaming', 'quality', '{"quality":"low","width":854,"height":480,"frameRate":24,"videoBitrate":"500k","audioBitrate":"64k"}', 0),
('Medium Quality', 'Standard 720p streaming', 'quality', '{"quality":"medium","width":1280,"height":720,"frameRate":30,"videoBitrate":"1500k","audioBitrate":"128k"}', 1),
('High Quality', 'High quality 1080p streaming', 'quality', '{"quality":"high","width":1920,"height":1080,"frameRate":30,"videoBitrate":"3000k","audioBitrate":"192k"}', 0),
('Test Pattern', 'Test pattern for debugging', 'content', '{"contentType":"testPattern","autoStart":false}', 0),
('Video Loop', 'Loop video file continuously', 'content', '{"contentType":"videoFile","loop":true}', 0);