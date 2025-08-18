-- ViewBot Database Schema
-- Designed for persistent storage of ViewBot configurations, state, and history

-- ViewBot Instances table
-- Stores persistent ViewBot configurations
CREATE TABLE IF NOT EXISTS viewbots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL, -- JSON string of bot configuration
    content_type TEXT NOT NULL CHECK(content_type IN ('testPattern', 'customText', 'videoFile', 'webCam', 'screenCapture')),
    is_enabled BOOLEAN DEFAULT 1,
    auto_start BOOLEAN DEFAULT 0,
    time_allotment INTEGER, -- Custom time allotment in milliseconds, NULL for random
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    usage_count INTEGER DEFAULT 0
);

-- ViewBot Sessions table
-- Tracks individual streaming sessions for analytics
CREATE TABLE IF NOT EXISTS viewbot_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    viewbot_id INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    duration_ms INTEGER,
    stream_quality TEXT,
    viewer_count INTEGER DEFAULT 0,
    rotation_reason TEXT, -- 'time-expired', 'manual', 'takeover', etc.
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'completed', 'failed', 'interrupted')),
    error_message TEXT,
    metadata TEXT, -- JSON string for additional session data
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE
);

-- ViewBot System State table
-- Stores global ViewBot system settings (singleton)
CREATE TABLE IF NOT EXISTS viewbot_system_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    rotation_enabled BOOLEAN DEFAULT 0,
    current_live_bot TEXT, -- bot_id of currently active ViewBot
    real_streamer_active BOOLEAN DEFAULT 0,
    max_bots INTEGER DEFAULT -1, -- -1 for unlimited
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ViewBot Rotation History table
-- Tracks rotation events for analytics and debugging
CREATE TABLE IF NOT EXISTS viewbot_rotation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_bot_id TEXT,
    to_bot_id TEXT,
    rotation_reason TEXT NOT NULL,
    rotation_type TEXT DEFAULT 'automatic' CHECK(rotation_type IN ('automatic', 'manual', 'forced')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    duration_before_rotation INTEGER, -- milliseconds
    viewer_count_at_rotation INTEGER DEFAULT 0,
    metadata TEXT -- JSON string for additional rotation data
);

-- ViewBot Performance Metrics table
-- Tracks performance and health metrics over time
CREATE TABLE IF NOT EXISTS viewbot_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewbot_id INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    session_id TEXT,
    metric_type TEXT NOT NULL CHECK(metric_type IN ('health_check', 'stream_quality', 'viewer_engagement', 'error_rate')),
    metric_value REAL NOT NULL,
    metric_unit TEXT, -- 'percentage', 'count', 'milliseconds', etc.
    measured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    additional_data TEXT, -- JSON string for detailed metric data
    FOREIGN KEY (viewbot_id) REFERENCES viewbots (id) ON DELETE CASCADE
);

-- ViewBot Content Sources table
-- Stores reusable content configurations
CREATE TABLE IF NOT EXISTS viewbot_content_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    content_type TEXT NOT NULL,
    config TEXT NOT NULL, -- JSON configuration
    file_path TEXT, -- For video files, images, etc.
    is_active BOOLEAN DEFAULT 1,
    usage_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_viewbots_bot_id ON viewbots(bot_id);
CREATE INDEX IF NOT EXISTS idx_viewbots_enabled ON viewbots(is_enabled);
CREATE INDEX IF NOT EXISTS idx_viewbots_content_type ON viewbots(content_type);

CREATE INDEX IF NOT EXISTS idx_viewbot_sessions_viewbot_id ON viewbot_sessions(viewbot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_sessions_bot_id ON viewbot_sessions(bot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_sessions_status ON viewbot_sessions(status);
CREATE INDEX IF NOT EXISTS idx_viewbot_sessions_started_at ON viewbot_sessions(started_at);

CREATE INDEX IF NOT EXISTS idx_viewbot_rotation_from_bot ON viewbot_rotation_history(from_bot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_rotation_to_bot ON viewbot_rotation_history(to_bot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_rotation_timestamp ON viewbot_rotation_history(timestamp);

CREATE INDEX IF NOT EXISTS idx_viewbot_metrics_viewbot_id ON viewbot_metrics(viewbot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_metrics_bot_id ON viewbot_metrics(bot_id);
CREATE INDEX IF NOT EXISTS idx_viewbot_metrics_type ON viewbot_metrics(metric_type);
CREATE INDEX IF NOT EXISTS idx_viewbot_metrics_measured_at ON viewbot_metrics(measured_at);

CREATE INDEX IF NOT EXISTS idx_viewbot_content_sources_type ON viewbot_content_sources(content_type);
CREATE INDEX IF NOT EXISTS idx_viewbot_content_sources_active ON viewbot_content_sources(is_active);

-- Insert default system state
INSERT OR IGNORE INTO viewbot_system_state (id, rotation_enabled, real_streamer_active) 
VALUES (1, 0, 0);