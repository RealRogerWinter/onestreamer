const { db } = require('../database/database');
const fs = require('fs');
const path = require('path');

/**
 * Migration to set up ViewBot database tables for persistent storage
 * This enables ViewBots to survive server restarts and maintain state/history
 */
async function setupViewBotTables() {
    console.log('🗃️ VIEWBOT MIGRATION: Setting up ViewBot database tables...');
    
    try {
        // Read the schema SQL file
        const schemaPath = path.join(__dirname, '..', 'database', 'viewbot-schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        
        // Split the SQL into individual statements
        const statements = schemaSql.split(';').filter(stmt => stmt.trim());
        
        // Execute each statement
        for (const statement of statements) {
            const trimmed = statement.trim();
            if (trimmed) {
                await new Promise((resolve, reject) => {
                    db.run(trimmed, function(err) {
                        if (err) {
                            console.error('❌ VIEWBOT MIGRATION: Error executing SQL:', trimmed.substring(0, 100) + '...');
                            console.error('Error:', err.message);
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                });
            }
        }
        
        console.log('✅ VIEWBOT MIGRATION: ViewBot database tables created successfully');
        return true;
        
    } catch (error) {
        console.error('❌ VIEWBOT MIGRATION: Failed to set up ViewBot tables:', error);
        throw error;
    }
}

/**
 * Rollback function to remove ViewBot tables
 */
async function rollbackViewBotTables() {
    console.log('🗃️ VIEWBOT MIGRATION: Rolling back ViewBot database tables...');
    
    const tables = [
        'viewbot_metrics',
        'viewbot_rotation_history', 
        'viewbot_sessions',
        'viewbot_content_sources',
        'viewbot_system_state',
        'viewbots'
    ];
    
    try {
        for (const table of tables) {
            await new Promise((resolve, reject) => {
                db.run(`DROP TABLE IF EXISTS ${table}`, function(err) {
                    if (err) {
                        console.error(`❌ VIEWBOT MIGRATION: Error dropping table ${table}:`, err);
                        reject(err);
                    } else {
                        console.log(`🗑️ VIEWBOT MIGRATION: Dropped table ${table}`);
                        resolve();
                    }
                });
            });
        }
        
        console.log('✅ VIEWBOT MIGRATION: ViewBot tables rollback completed');
        return true;
        
    } catch (error) {
        console.error('❌ VIEWBOT MIGRATION: Failed to rollback ViewBot tables:', error);
        throw error;
    }
}

// Run migration if called directly
if (require.main === module) {
    setupViewBotTables()
        .then(() => {
            console.log('✅ VIEWBOT MIGRATION: Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ VIEWBOT MIGRATION: Migration failed:', error);
            process.exit(1);
        });
}

module.exports = {
    setupViewBotTables,
    rollbackViewBotTables
};