-- Create chatbots table
CREATE TABLE IF NOT EXISTS chatbots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL,
    color TEXT DEFAULT '#4ECDC4',
    response_rate REAL DEFAULT 0.3,
    personality TEXT,
    system_prompt TEXT,
    is_enabled BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert some default chatbots
INSERT INTO chatbots (name, username, color, response_rate, personality, system_prompt, is_enabled)
SELECT 'John', '🤖 John', '#4ECDC4', 0.3, 'friendly and helpful', 'You are a friendly chatbot named John. Be helpful and engaging.', 1
WHERE NOT EXISTS (SELECT 1 FROM chatbots WHERE username = '🤖 John');

INSERT INTO chatbots (name, username, color, response_rate, personality, system_prompt, is_enabled)
SELECT 'Frank', '🤖 Frank', '#FF6B6B', 0.25, 'sarcastic but funny', 'You are Frank, a sarcastic but funny chatbot. Make witty remarks but stay friendly.', 1
WHERE NOT EXISTS (SELECT 1 FROM chatbots WHERE username = '🤖 Frank');