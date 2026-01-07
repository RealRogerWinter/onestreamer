const database = require('../database/database');

async function migrate() {
    console.log('🔄 Starting Auto-Summon Bot migration...');

    try {
        // Create auto_summon_settings table
        await database.runAsync(`
            CREATE TABLE IF NOT EXISTS auto_summon_settings (
                id INTEGER PRIMARY KEY DEFAULT 1,
                enabled INTEGER DEFAULT 0,
                interval_minutes INTEGER DEFAULT 70,
                bot_duration_seconds INTEGER DEFAULT 3600,
                last_summoned_at DATETIME,
                total_summoned INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Created auto_summon_settings table');

        // Insert default settings
        await database.runAsync(`
            INSERT OR IGNORE INTO auto_summon_settings (id, enabled, interval_minutes, bot_duration_seconds)
            VALUES (1, 0, 70, 3600)
        `);
        console.log('✅ Inserted default auto-summon settings');

        // Create table for tracking auto-summoned bots history
        await database.runAsync(`
            CREATE TABLE IF NOT EXISTS auto_summoned_bots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chatbot_id INTEGER,
                bot_name TEXT NOT NULL,
                personality_prompt TEXT NOT NULL,
                generated_prompt TEXT,
                summoned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                expired_at DATETIME,
                FOREIGN KEY (chatbot_id) REFERENCES chatbots(id)
            )
        `);
        console.log('✅ Created auto_summoned_bots history table');

        console.log('✅ Auto-Summon Bot migration completed successfully');
    } catch (error) {
        if (error.message.includes('already exists')) {
            console.log('⚠️ Tables already exist, skipping migration');
        } else {
            console.error('❌ Migration failed:', error);
            throw error;
        }
    }
}

// Run migration if called directly
if (require.main === module) {
    migrate().then(() => {
        console.log('Migration complete');
        process.exit(0);
    }).catch(error => {
        console.error('Migration failed:', error);
        process.exit(1);
    });
}

module.exports = migrate;
