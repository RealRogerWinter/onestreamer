const ChatBotService = require('./server/services/ChatBotService');

async function forceDisableAllBots() {
    console.log('🤖 FORCE DISABLING all chatbots...\n');
    
    const chatBotService = new ChatBotService();
    
    try {
        // Initialize first
        await chatBotService.initialize();
        console.log('🤖 ChatBot service initialized');
        
        // Force disable all
        const result = await chatBotService.disableAllBots();
        console.log('\n✅ Successfully force-disabled all bots!');
        console.log('Result:', result);
        
        // Also force shutdown any running instances
        chatBotService.shutdown();
        console.log('🤖 ChatBot service shut down');
        
    } catch (error) {
        console.error('❌ Failed to force disable bots:', error);
    } finally {
        // Close database connection and exit
        const database = require('./server/database/database');
        if (database.db) {
            database.db.close();
        }
        process.exit(0);
    }
}

forceDisableAllBots();