const database = require('./server/database/database');

async function cleanupDuplicateBots() {
    console.log('🧹 Cleaning up duplicate chatbots...\n');
    
    try {
        // Get all bots
        const allBots = await database.allAsync('SELECT * FROM chatbots ORDER BY created_at DESC');
        console.log(`Found ${allBots.length} total bots`);
        
        // Group by name
        const botsByName = {};
        allBots.forEach(bot => {
            if (!botsByName[bot.name]) {
                botsByName[bot.name] = [];
            }
            botsByName[bot.name].push(bot);
        });
        
        // Remove duplicates (keep the newest one)
        for (const name in botsByName) {
            const bots = botsByName[name];
            if (bots.length > 1) {
                console.log(`\nFound ${bots.length} bots named "${name}"`);
                // Keep the first one (newest due to ORDER BY created_at DESC)
                const keepBot = bots[0];
                console.log(`  Keeping bot ID ${keepBot.id} (created: ${keepBot.created_at})`);
                
                // Delete the rest
                for (let i = 1; i < bots.length; i++) {
                    console.log(`  Deleting bot ID ${bots[i].id} (created: ${bots[i].created_at})`);
                    await database.runAsync('DELETE FROM chatbots WHERE id = ?', [bots[i].id]);
                }
            }
        }
        
        // Show final state
        const remainingBots = await database.allAsync('SELECT * FROM chatbots ORDER BY created_at DESC');
        console.log(`\n✅ Cleanup complete! ${remainingBots.length} bots remaining:`);
        remainingBots.forEach(bot => {
            console.log(`  - ${bot.name} (ID: ${bot.id}, ${bot.is_enabled ? 'Enabled' : 'Disabled'})`);
        });
        
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    } finally {
        database.db.close();
    }
}

cleanupDuplicateBots();