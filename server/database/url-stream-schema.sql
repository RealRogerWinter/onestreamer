-- URL Stream ViewBot Schema
-- Tracks URL stream sessions and history

-- Main URL streams table
CREATE TABLE IF NOT EXISTS url_streams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id TEXT UNIQUE NOT NULL,
    source_url TEXT NOT NULL,
    platform TEXT,
    quality TEXT DEFAULT 'best',
    display_name TEXT,
    status TEXT DEFAULT 'pending',
    started_at DATETIME,
    ended_at DATETIME,
    end_reason TEXT,
    total_uptime INTEGER DEFAULT 0,
    reconnect_count INTEGER DEFAULT 0,
    auto_reconnect BOOLEAN DEFAULT 1,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- URL stream session logs
CREATE TABLE IF NOT EXISTS url_stream_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_stream_id INTEGER REFERENCES url_streams(id),
    url_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT,
    metadata TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- URL stream health metrics
CREATE TABLE IF NOT EXISTS url_stream_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id TEXT NOT NULL,
    source_status TEXT,
    ffmpeg_status TEXT,
    frame_count INTEGER DEFAULT 0,
    bitrate TEXT,
    fps TEXT,
    overall_health INTEGER DEFAULT 100,
    error_count INTEGER DEFAULT 0,
    warning_count INTEGER DEFAULT 0,
    last_check DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Saved URL stream presets (for quick restart)
CREATE TABLE IF NOT EXISTS url_stream_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    platform TEXT,
    quality TEXT DEFAULT 'best',
    display_name TEXT,
    auto_reconnect BOOLEAN DEFAULT 1,
    is_active BOOLEAN DEFAULT 1,
    last_used DATETIME,
    use_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_url_streams_url_id ON url_streams(url_id);
CREATE INDEX IF NOT EXISTS idx_url_streams_status ON url_streams(status);
CREATE INDEX IF NOT EXISTS idx_url_stream_logs_url_id ON url_stream_logs(url_id);
CREATE INDEX IF NOT EXISTS idx_url_stream_logs_timestamp ON url_stream_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_url_stream_health_url_id ON url_stream_health(url_id);
CREATE INDEX IF NOT EXISTS idx_url_stream_presets_name ON url_stream_presets(name);
