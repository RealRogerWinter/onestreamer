const ChatBotService = require('./server/services/ChatBotService');
const database = require('./server/database/database');

async function testBotChat() {
    console.log('🤖 Testing ChatBot Chat Integration...\n');
    
    const chatBotService = new ChatBotService();
    
    try {
        // Get first bot
        const bots = await database.allAsync('SELECT * FROM chatbots LIMIT 1');
        
        if (bots.length === 0) {
            console.log('❌ No bots found in database');
            console.log('   Create a bot in the admin panel first');
            database.db.close();
            return;
        }
        
        const bot = bots[0];
        console.log(`📋 Testing with bot: ${bot.name} (ID: ${bot.id})`);
        console.log(`   Chat service URL: ${chatBotService.chatServiceUrl}`);
        
        // Send a manual message
        console.log('\n📤 Sending test message...');
        
        try {
            const result = await chatBotService.sendManualMessage(bot.id, 'Hello from test! This is a bot test message! 🤖');
            console.log('✅ Message sent successfully!');
            console.log(`   Bot: ${result.bot_name}`);
            console.log(`   Message: "${result.message}"`);
            console.log('\n✨ Check your chat window - the message should appear there!');
        } catch (error) {
            console.error('❌ Failed to send message:', error.message);
            console.error('\nTroubleshooting:');
            console.error('1. Make sure the chat service is running on port 8081');
            console.error('2. Restart the main server to apply port changes');
            console.error('3. Check that you can see the chat in your browser');
        }
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        // Give time for message to be sent
        setTimeout(() => {
            database.db.close();
            process.exit(0);
        }, 2000);
    }
}

testBotChat();