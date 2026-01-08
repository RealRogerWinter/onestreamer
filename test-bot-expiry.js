const database = require('./server/database/database');
const ChatBotService = require('./server/services/ChatBotService');

async function testBotExpiry() {
    console.log('🧪 Testing bot expiry fix...');
    
    try {
        // Database is already initialized in the module
        
        // Create ChatBotService instance
        const chatBotService = new ChatBotService();
        
        // Check for expired temporary bots
        console.log('\n📋 Checking for expired temporary bots in database...');
        const expiredBots = await database.allAsync(
            'SELECT id, name, expires_at, is_temporary FROM chatbots WHERE is_temporary = 1 AND expires_at < datetime("now")'
        );
        
        if (expiredBots.length > 0) {
            console.log(`❌ Found ${expiredBots.length} expired temporary bots:`);
            for (const bot of expiredBots) {
                console.log(`  - ${bot.name} (ID: ${bot.id}) expired at ${bot.expires_at}`);
            }
            
            // Run cleanup
            console.log('\n🧹 Running cleanup...');
            const cleanedCount = await chatBotService.cleanupExpiredBots();
            console.log(`✅ Cleaned up ${cleanedCount} expired bots`);
        } else {
            console.log('✅ No expired temporary bots found');
        }
        
        // Check active temporary bots
        console.log('\n📋 Checking active temporary bots...');
        const activeTempBots = await database.allAsync(
            'SELECT id, name, expires_at FROM chatbots WHERE is_temporary = 1 AND expires_at > datetime("now")'
        );
        
        if (activeTempBots.length > 0) {
            console.log(`📌 Found ${activeTempBots.length} active temporary bots:`);
            for (const bot of activeTempBots) {
                const expiresAt = new Date(bot.expires_at);
                const now = new Date();
                const remainingMs = expiresAt - now;
                const remainingMins = Math.floor(remainingMs / 60000);
                console.log(`  - ${bot.name} (ID: ${bot.id}) expires in ${remainingMins} minutes`);
            }
        } else {
            console.log('📌 No active temporary bots found');
        }
        
        // Check if any bots are in the ChatBotService Map
        console.log('\n📋 Checking ChatBotService bot Map...');
        console.log(`  - Bots in memory: ${chatBotService.bots.size}`);
        
        if (chatBotService.bots.size > 0) {
            for (const [id, bot] of chatBotService.bots) {
                console.log(`    • Bot ${id}: ${bot.data?.name} (connected: ${bot.connected})`);
            }
        }
        
    } catch (error) {
        console.error('❌ Error during testing:', error);
    } finally {
        console.log('\n✅ Test complete');
        process.exit(0);
    }
}

testBotExpiry();