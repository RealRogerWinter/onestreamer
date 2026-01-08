const database = require('./server/database/database');

async function cleanupExpiredBots() {
    console.log('🧹 Manual cleanup of expired bots...');
    
    try {
        // Find all expired temporary bots
        const expired = await database.allAsync(
            'SELECT id, name, expires_at FROM chatbots WHERE is_temporary = 1 AND expires_at < datetime("now")'
        );
        
        if (expired.length === 0) {
            console.log('✅ No expired temporary bots found');
            return;
        }
        
        console.log(`❌ Found ${expired.length} expired temporary bots:`);
        for (const bot of expired) {
            console.log(`  - ${bot.name} (ID: ${bot.id}) expired at ${bot.expires_at}`);
            
            // Delete from temporary_bots table first
            await database.runAsync('DELETE FROM temporary_bots WHERE chatbot_id = ?', [bot.id]);
            console.log(`    ✓ Removed from temporary_bots table`);
            
            // Delete from chatbots table
            await database.runAsync('DELETE FROM chatbots WHERE id = ?', [bot.id]);
            console.log(`    ✓ Removed from chatbots table`);
        }
        
        console.log(`\n✅ Successfully cleaned up ${expired.length} expired temporary bots`);
        
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    } finally {
        console.log('\n✅ Cleanup complete');
        process.exit(0);
    }
}

cleanupExpiredBots();