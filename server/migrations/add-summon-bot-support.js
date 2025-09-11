const database = require('../database/database');

async function migrate() {
    console.log('🔄 Starting Summon Bot migration...');
    
    try {
        // Add columns to chatbots table for temporary bot tracking
        await database.runAsync(`
            ALTER TABLE chatbots ADD COLUMN is_temporary BOOLEAN DEFAULT 0
        `);
        console.log('✅ Added is_temporary column');
        
        await database.runAsync(`
            ALTER TABLE chatbots ADD COLUMN summoned_by_user_id INTEGER
        `);
        console.log('✅ Added summoned_by_user_id column');
        
        await database.runAsync(`
            ALTER TABLE chatbots ADD COLUMN expires_at DATETIME
        `);
        console.log('✅ Added expires_at column');
        
        await database.runAsync(`
            ALTER TABLE chatbots ADD COLUMN summon_item_id INTEGER
        `);
        console.log('✅ Added summon_item_id column');
        
        // Create index for efficient cleanup queries
        await database.runAsync(`
            CREATE INDEX IF NOT EXISTS idx_chatbots_temporary_expires 
            ON chatbots(is_temporary, expires_at)
        `);
        console.log('✅ Created index for temporary bot cleanup');
        
        console.log('✅ Summon Bot migration completed successfully');
    } catch (error) {
        if (error.message.includes('duplicate column name')) {
            console.log('⚠️ Columns already exist, skipping migration');
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