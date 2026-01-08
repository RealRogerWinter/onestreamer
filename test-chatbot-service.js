const ChatBotService = require('./server/services/ChatBotService');
const database = require('./server/database/database');

async function testChatBotService() {
    console.log('🧪 Testing ChatBot Service...\n');
    
    const chatBotService = new ChatBotService();
    
    try {
        // Test 1: Check LLM availability
        console.log('1️⃣ Testing LLM Service...');
        const llmAvailable = await chatBotService.llmService.testConnection();
        console.log(`   LLM Available: ${llmAvailable ? '✅ Yes' : '❌ No (using fallback)'}`);
        console.log(`   Model: ${chatBotService.llmService.model}`);
        console.log('');
        
        // Test 2: Create a test bot
        console.log('2️⃣ Creating test chatbot...');
        const testBot = await chatBotService.createBot({
            name: 'TestBot',
            prompt: 'You are a friendly test bot who loves testing!',
            is_enabled: false, // Start disabled for testing
            response_interval_min: 30,
            response_interval_max: 60,
            show_robot_emoji: true,
            personality_traits: {
                enthusiasm: true,
                casual: true,
                temperature: 0.8
            }
        });
        console.log(`   Created bot: ${testBot.name} (ID: ${testBot.id})`);
        console.log('');
        
        // Test 3: Generate a test response
        console.log('3️⃣ Testing response generation...');
        const testContext = [
            { username: 'User1', message: 'Hey everyone!' },
            { username: 'User2', message: 'What\'s happening in the stream?' },
            { username: 'User3', message: 'This is so cool!' }
        ];
        
        const response = await chatBotService.llmService.generateResponse(
            testBot.prompt,
            testContext,
            { enthusiasm: true, casual: true, temperature: 0.8 }
        );
        console.log(`   Generated response: "${response}"`);
        console.log('');
        
        // Test 4: Test the test endpoint
        console.log('4️⃣ Testing bot through API endpoint...');
        const testResult = await chatBotService.testBot(testBot.id);
        console.log(`   Bot: ${testResult.bot_name}`);
        console.log(`   Response: "${testResult.response}"`);
        console.log('');
        
        // Test 5: Update bot
        console.log('5️⃣ Updating bot configuration...');
        const updatedBot = await chatBotService.updateBot(testBot.id, {
            prompt: 'You are an updated test bot!',
            response_interval_min: 45,
            response_interval_max: 90
        });
        console.log(`   Updated bot prompt and intervals`);
        console.log('');
        
        // Test 6: Get all bots
        console.log('6️⃣ Fetching all bots...');
        const allBots = await chatBotService.getAllBots();
        console.log(`   Total bots in database: ${allBots.length}`);
        allBots.forEach(bot => {
            console.log(`   - ${bot.name} (${bot.is_enabled ? 'Enabled' : 'Disabled'})`);
        });
        console.log('');
        
        // Test 7: Clean up - delete test bot
        console.log('7️⃣ Cleaning up test bot...');
        await chatBotService.deleteBot(testBot.id);
        console.log(`   Deleted test bot`);
        console.log('');
        
        console.log('✅ All tests completed successfully!');
        
        // Test 8: Create a demo bot for actual use
        console.log('\n8️⃣ Creating demo chatbot for testing with chat service...');
        const demoBot = await chatBotService.createBot({
            name: 'FriendlyBot',
            prompt: 'You are a friendly viewer who loves watching streams and chatting with others. Keep responses short and casual.',
            is_enabled: false, // User can enable through admin panel
            response_interval_min: 60,
            response_interval_max: 120,
            show_robot_emoji: true,
            personality_traits: {
                enthusiasm: true,
                casual: true,
                supportive: true,
                temperature: 0.7
            }
        });
        console.log(`   Created demo bot: ${demoBot.name} (ID: ${demoBot.id})`);
        console.log('   ℹ️  Bot is disabled by default. Enable it through the admin panel to start chatting!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        // Close database connection
        database.db.close();
        process.exit(0);
    }
}

// Run tests
testChatBotService();