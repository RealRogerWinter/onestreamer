-- Create table for StreamBot periodic messages
CREATE TABLE IF NOT EXISTS streambot_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    enabled BOOLEAN DEFAULT 1,
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create table for StreamBot settings
CREATE TABLE IF NOT EXISTS streambot_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    interval_minutes INTEGER DEFAULT 15,
    enabled BOOLEAN DEFAULT 1,
    current_message_index INTEGER DEFAULT 0,
    last_sent_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default settings
INSERT INTO streambot_settings (interval_minutes, enabled, current_message_index)
SELECT 15, 1, 0
WHERE NOT EXISTS (SELECT 1 FROM streambot_settings);

-- Insert default Discord message
INSERT INTO streambot_messages (message, enabled, order_index)
VALUES ('📢 Join the OneStreamer Discord community! Connect with other streamers, get support, and stay updated: https://discord.gg/As5CA3ekYA', 1, 0);