const { runAsync } = require('../database/database');

async function migrateUnlimitedStock() {
    console.log('🔄 Migrating unlimited stock items from -1 to 0...');
    
    try {
        const result = await runAsync(
            'UPDATE shop_items SET stock_limit = 0 WHERE stock_limit = -1'
        );
        
        console.log(`✅ Migrated ${result.changes} items from unlimited stock (-1) to unlimited stock (0)`);
        return result.changes;
    } catch (error) {
        console.error('❌ Error migrating unlimited stock:', error);
        throw error;
    }
}

// Run migration if called directly
if (require.main === module) {
    migrateUnlimitedStock()
        .then(changes => {
            console.log(`Migration completed successfully. ${changes} items updated.`);
            process.exit(0);
        })
        .catch(error => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
}

module.exports = migrateUnlimitedStock;