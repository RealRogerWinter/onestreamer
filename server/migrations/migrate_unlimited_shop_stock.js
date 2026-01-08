const { runAsync } = require('../database/database');

async function migrateUnlimitedShopStock() {
    try {
        console.log('🔄 Migrating shop items to unlimited stock by default...');
        
        // Update all existing shop items to have unlimited stock (stock_limit = 0)
        // This resets any limited stock back to unlimited
        const result = await runAsync(
            'UPDATE shop_items SET stock_limit = 0 WHERE stock_limit != 0'
        );
        
        console.log(`✅ Migrated ${result.changes} shop items to unlimited stock (stock_limit = 0)`);
        
    } catch (error) {
        console.error('❌ Error migrating unlimited shop stock:', error);
        throw error;
    }
}

module.exports = migrateUnlimitedShopStock;

// Run migration if called directly
if (require.main === module) {
    migrateUnlimitedShopStock()
        .then(() => {
            console.log('✅ Shop stock migration completed successfully');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Shop stock migration failed:', error);
            process.exit(1);
        });
}