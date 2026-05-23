const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', '..', 'server', 'database', 'database.db');
const db = new sqlite3.Database(dbPath);

console.log('Setting up ChatBot tables...\n');

db.serialize(() => {
    // Create chatbots table with use_assigned_name field
    db.run(`
        CREATE TABLE IF NOT EXISTS chatbots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL,
            is_enabled BOOLEAN DEFAULT 1,
            response_interval_min INTEGER DEFAULT 60,
            response_interval_max INTEGER DEFAULT 180,
            show_robot_emoji BOOLEAN DEFAULT 1,
            personality_traits TEXT,
            use_assigned_name BOOLEAN DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error('Error creating chatbots table:', err);
        } else {
            console.log('✅ Created/verified chatbots table');
        }
    });

    // Create chatbot_sessions table
    db.run(`
        CREATE TABLE IF NOT EXISTS chatbot_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chatbot_id INTEGER NOT NULL,
            socket_id TEXT,
            username TEXT NOT NULL,
            color TEXT NOT NULL,
            connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_message_at DATETIME,
            FOREIGN KEY (chatbot_id) REFERENCES chatbots (id) ON DELETE CASCADE
        )
    `, (err) => {
        if (err) {
            console.error('Error creating chatbot_sessions table:', err);
        } else {
            console.log('✅ Created/verified chatbot_sessions table');
        }
    });

    // Create chatbot_message_history table
    db.run(`
        CREATE TABLE IF NOT EXISTS chatbot_message_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chatbot_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            context TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chatbot_id) REFERENCES chatbots (id) ON DELETE CASCADE
        )
    `, (err) => {
        if (err) {
            console.error('Error creating chatbot_message_history table:', err);
        } else {
            console.log('✅ Created/verified chatbot_message_history table');
        }
    });

    // Create indices
    db.run(`CREATE INDEX IF NOT EXISTS idx_chatbots_enabled ON chatbots(is_enabled)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_chatbot_sessions_bot_id ON chatbot_sessions(chatbot_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_chatbot_message_history_bot_id ON chatbot_message_history(chatbot_id)`);

    // Insert default bots if table is empty
    db.get('SELECT COUNT(*) as count FROM chatbots', (err, row) => {
        if (!err && row.count === 0) {
            console.log('\n📝 Inserting default bots...');
            
            const defaultBots = [
                {
                    name: 'ChillViewer',
                    prompt: 'You are a laid-back viewer who enjoys the stream and likes to make casual comments.',
                    personality: { casual: true, supportive: true, temperature: 0.7 },
                    use_assigned_name: 1
                },
                {
                    name: 'HypeGamer',
                    prompt: 'You are an enthusiastic gamer who gets excited about gameplay and achievements.',
                    personality: { enthusiasm: true, curious: true, temperature: 0.8 },
                    use_assigned_name: 1
                },
                {
                    name: 'JokesterBear',
                    prompt: 'You are a funny viewer who likes to make jokes and keep the mood light.',
                    personality: { humorous: true, casual: true, temperature: 0.9 },
                    use_assigned_name: 1
                }
            ];

            defaultBots.forEach(bot => {
                db.run(`
                    INSERT INTO chatbots (name, prompt, is_enabled, personality_traits, use_assigned_name)
                    VALUES (?, ?, 1, ?, ?)
                `, [bot.name, bot.prompt, JSON.stringify(bot.personality), bot.use_assigned_name], (err) => {
                    if (err) {
                        console.error(`Error inserting bot ${bot.name}:`, err);
                    } else {
                        console.log(`   ✅ Added bot: ${bot.name}`);
                    }
                });
            });
        } else {
            console.log('\n✅ Bots already exist in database');
            
            // Show existing bots
            db.all('SELECT id, name, is_enabled, use_assigned_name FROM chatbots', (err, bots) => {
                if (!err && bots.length > 0) {
                    console.log('\n📋 Current bots:');
                    bots.forEach(bot => {
                        const status = bot.is_enabled ? 'ON' : 'OFF';
                        const nameMode = bot.use_assigned_name ? 'assigned name' : 'random name';
                        console.log(`   Bot "${bot.name}" (ID: ${bot.id}) - ${status}, uses ${nameMode}`);
                    });
                }
            });
        }
        
        setTimeout(() => {
            db.close();
            console.log('\n✨ ChatBot tables setup complete!');
        }, 1000);
    });
});