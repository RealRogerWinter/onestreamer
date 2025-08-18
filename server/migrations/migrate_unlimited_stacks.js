const { runAsync } = require('../database/database');

async function migrateUnlimitedStacks() {
    try {
        console.log('🔄 Migrating items to unlimited stacks by default...');
        
        // Update all existing items to have unlimited stacks (max_stack = 0) 
        // This makes unlimited the default behavior
        const result = await runAsync(
            'UPDATE items SET max_stack = 0 WHERE max_stack > 0'
        );
        
        console.log(`✅ Migrated ${result.changes} items to unlimited stacks (max_stack = 0)`);
        
    } catch (error) {
        console.error('❌ Error migrating unlimited stacks:', error);
        throw error;
    }
}

module.exports = migrateUnlimitedStacks;

// Run migration if called directly
if (require.main === module) {
    migrateUnlimitedStacks()
        .then(() => {
            console.log('✅ Migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Migration failed:', error);
            process.exit(1);
        });
}