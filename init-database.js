const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'data', 'onestreamer.db');

console.log('🚀 Initializing database at:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    console.log('✅ Connected to database');
});

async function runQuery(sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function initializeTables() {
    try {
        // Create items table
        console.log('Creating items table...');
        await runQuery(`
            CREATE TABLE IF NOT EXISTS items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                emoji TEXT NOT NULL,
                description TEXT NOT NULL,
                item_type TEXT NOT NULL CHECK(item_type IN ('buff', 'debuff', 'utility', 'guard', 'weapon', 'marker')),
                rarity TEXT NOT NULL CHECK(rarity IN ('common', 'uncommon', 'rare', 'epic', 'legendary')),
                base_price INTEGER NOT NULL DEFAULT 0,
                is_purchasable BOOLEAN DEFAULT 1,
                is_active BOOLEAN DEFAULT 1,
                cooldown_seconds INTEGER DEFAULT 0,
                max_stack INTEGER DEFAULT 0,
                duration_seconds INTEGER DEFAULT 0,
                effect_data TEXT,
                stack_behavior TEXT DEFAULT 'replace',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Items table created');

        // Create shop_items table
        console.log('Creating shop_items table...');
        await runQuery(`
            CREATE TABLE IF NOT EXISTS shop_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                price INTEGER NOT NULL,
                discount_percentage INTEGER DEFAULT 0,
                is_featured BOOLEAN DEFAULT 0,
                stock_limit INTEGER DEFAULT -1,
                available_from DATETIME,
                available_until DATETIME,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
            )
        `);
        console.log('✅ Shop_items table created');

        // Create active_buffs table
        console.log('Creating active_buffs table...');
        await runQuery(`
            CREATE TABLE IF NOT EXISTS active_buffs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                applied_by_user_id INTEGER NOT NULL,
                buff_type TEXT NOT NULL CHECK(buff_type IN ('buff', 'debuff')),
                duration_seconds INTEGER NOT NULL,
                remaining_seconds INTEGER NOT NULL,
                streaming_time_used INTEGER DEFAULT 0,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT 1,
                metadata TEXT,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
                FOREIGN KEY (applied_by_user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        `);
        console.log('✅ Active_buffs table created');

        // Create user_inventory table
        console.log('Creating user_inventory table...');
        await runQuery(`
            CREATE TABLE IF NOT EXISTS user_inventory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                item_id INTEGER NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                acquired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_used_at DATETIME,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
                UNIQUE(user_id, item_id)
            )
        `);
        console.log('✅ User_inventory table created');

        // Create chatbot_config table
        console.log('Creating chatbot_config table...');
        await runQuery(`
            CREATE TABLE IF NOT EXISTS chatbot_config (
                id INTEGER PRIMARY KEY DEFAULT 1,
                global_prompt TEXT,
                llm_model TEXT DEFAULT 'llama3.2:latest',
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Chatbot_config table created');

        // Create recordings table
        console.log('Creating recordings table...');
        await runQuery(`
            CREATE TABLE IF NOT EXISTS recordings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT NOT NULL,
                stream_id TEXT NOT NULL,
                user_id INTEGER,
                size INTEGER,
                duration REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'active',
                metadata TEXT
            )
        `);
        console.log('✅ Recordings table created');

        // Insert default config if not exists
        console.log('Inserting default chatbot config...');
        await runQuery(`
            INSERT OR IGNORE INTO chatbot_config (id, global_prompt, llm_model)
            VALUES (1, 'You are a helpful assistant.', 'llama3.2:latest')
        `);
        console.log('✅ Default chatbot config inserted');

        // Add points_balance to users if not exists
        console.log('Adding points_balance to users table...');
        await runQuery(`
            ALTER TABLE users ADD COLUMN points_balance INTEGER DEFAULT 0
        `).catch(err => {
            if (err.message.includes('duplicate column')) {
                console.log('ℹ️  points_balance column already exists');
            } else {
                throw err;
            }
        });

        console.log('\n✅ All tables initialized successfully!');
        
    } catch (error) {
        console.error('❌ Error initializing tables:', error);
        process.exit(1);
    } finally {
        db.close();
    }
}

initializeTables();