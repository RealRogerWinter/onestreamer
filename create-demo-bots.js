const ChatBotService = require('./server/services/ChatBotService');
const database = require('./server/database/database');

async function createDemoBots() {
    console.log('🤖 Creating demo chatbots...\n');
    
    const chatBotService = new ChatBotService();
    await chatBotService.llmService.checkAvailability();
    
    try {
        // Clear existing bots first
        await database.runAsync('DELETE FROM chatbots');
        console.log('Cleared existing bots\n');
        
        // Bot 1: Friendly Viewer
        const bot1 = await chatBotService.createBot({
            name: 'ChillViewer',
            prompt: 'You are a chill and relaxed stream viewer. You occasionally make supportive comments and ask casual questions. Keep responses short and laid-back.',
            is_enabled: false,
            response_interval_min: 90,
            response_interval_max: 180,
            show_robot_emoji: true,
            personality_traits: {
                enthusiasm: false,
                casual: true,
                supportive: true,
                humorous: false,
                curious: false,
                temperature: 0.6
            }
        });
        console.log(`✅ Created ${bot1.name} - A relaxed viewer`);
        
        // Bot 2: Enthusiastic Gamer
        const bot2 = await chatBotService.createBot({
            name: 'HypeGamer',
            prompt: 'You are an enthusiastic gamer who loves the stream! You get excited about gameplay and use exclamation marks! You love to hype things up!',
            is_enabled: false,
            response_interval_min: 60,
            response_interval_max: 120,
            show_robot_emoji: true,
            personality_traits: {
                enthusiasm: true,
                casual: false,
                supportive: true,
                humorous: false,
                curious: false,
                temperature: 0.8
            }
        });
        console.log(`✅ Created ${bot2.name} - An enthusiastic gamer`);
        
        // Bot 3: Curious Newcomer
        const bot3 = await chatBotService.createBot({
            name: 'NewbieCat',
            prompt: 'You are new to the stream and curious about everything. You ask questions about what is happening and show genuine interest in learning.',
            is_enabled: false,
            response_interval_min: 120,
            response_interval_max: 240,
            show_robot_emoji: true,
            personality_traits: {
                enthusiasm: false,
                casual: true,
                supportive: false,
                humorous: false,
                curious: true,
                temperature: 0.7
            }
        });
        console.log(`✅ Created ${bot3.name} - A curious newcomer`);
        
        // Bot 4: Comedy Relief
        const bot4 = await chatBotService.createBot({
            name: 'JokesterBear',
            prompt: 'You love making jokes and funny observations about the stream. You keep things light and entertaining with humor and wordplay.',
            is_enabled: false,
            response_interval_min: 150,
            response_interval_max: 300,
            show_robot_emoji: true,
            personality_traits: {
                enthusiasm: false,
                casual: true,
                supportive: false,
                humorous: true,
                curious: false,
                temperature: 0.9
            }
        });
        console.log(`✅ Created ${bot4.name} - The comedian`);
        
        console.log('\n📋 Demo bots created successfully!');
        console.log('\n🎯 Next steps:');
        console.log('1. Start all services: node start-with-chatbots.js');
        console.log('2. Open http://localhost:3000');
        console.log('3. Login as admin');
        console.log('4. Go to Admin Panel > ChatBots tab');
        console.log('5. Test and enable the bots you want');
        console.log('6. Watch them chat!\n');
        
    } catch (error) {
        console.error('❌ Error creating demo bots:', error);
    } finally {
        database.db.close();
    }
}

createDemoBots();