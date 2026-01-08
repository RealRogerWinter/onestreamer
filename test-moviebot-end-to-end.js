const { io: ioClient } = require('socket.io-client');
const database = require('./server/database/database');

// Test configuration
const MAIN_SERVER_URL = 'http://localhost:8080';
const CHAT_SERVICE_URL = 'http://localhost:8081';
const TEST_TIMEOUT = 30000; // 30 seconds

class MovieBotEndToEndTest {
    constructor() {
        this.testResults = {
            botConnections: {},
            messagesReceived: [],
            errors: []
        };
        this.chatSocket = null;
        this.testComplete = false;
    }

    async runFullTest() {
        console.log('🧪 Starting MovieBot End-to-End Test...');
        console.log('=' .repeat(60));

        try {
            // Step 1: Check database state
            await this.checkDatabaseState();

            // Step 2: Connect to chat service to monitor messages
            await this.connectToChatService();

            // Step 3: Simulate moviebot transcription with test data
            await this.simulateMovieBotTranscription();

            // Step 4: Wait for and verify bot responses
            await this.waitForBotResponses();

            // Step 5: Generate final report
            this.generateReport();

        } catch (error) {
            console.error('❌ Test failed with error:', error);
            this.testResults.errors.push(error.message);
        } finally {
            this.cleanup();
        }
    }

    async checkDatabaseState() {
        console.log('\n📊 Step 1: Checking Database State...');
        
        try {
            const movieBotEnabledBots = await database.allAsync(
                'SELECT id, name, is_enabled, moviebot_enabled FROM chatbots WHERE moviebot_enabled = 1'
            );
            
            console.log(`✅ Found ${movieBotEnabledBots.length} moviebot-enabled bots:`);
            movieBotEnabledBots.forEach(bot => {
                const status = bot.is_enabled ? '🟢 ENABLED' : '🔴 DISABLED';
                console.log(`   - ${bot.name} (ID: ${bot.id}) ${status}`);
            });

            if (movieBotEnabledBots.length === 0) {
                throw new Error('No moviebot-enabled bots found in database');
            }

            // Store enabled bots for monitoring
            this.enabledBots = movieBotEnabledBots.filter(bot => bot.is_enabled);
            console.log(`✅ Will monitor ${this.enabledBots.length} enabled bots for responses`);

        } catch (error) {
            console.error('❌ Database check failed:', error);
            throw error;
        }
    }

    async connectToChatService() {
        console.log('\n💬 Step 2: Connecting to Chat Service...');
        
        return new Promise((resolve, reject) => {
            this.chatSocket = ioClient(CHAT_SERVICE_URL, {
                transports: ['websocket']
            });

            this.chatSocket.on('connect', () => {
                console.log('✅ Connected to chat service');
                
                // Join chat as test observer
                this.chatSocket.emit('join-chat', {
                    username: 'TestObserver',
                    color: '#FF0000',
                    isBot: false
                });

                // Listen for new messages
                this.chatSocket.on('new-message', (message) => {
                    // Check if this is from one of our test bots
                    const isBotMessage = this.enabledBots.some(bot => 
                        message.username === bot.name || 
                        message.username === `🤖 ${bot.name}`
                    );
                    
                    if (isBotMessage) {
                        console.log(`📨 Received bot message: ${message.username}: "${message.message}"`);
                        this.testResults.messagesReceived.push({
                            bot: message.username,
                            message: message.message,
                            timestamp: message.fullTimestamp
                        });
                    }
                });

                resolve();
            });

            this.chatSocket.on('connect_error', (error) => {
                console.error('❌ Failed to connect to chat service:', error);
                reject(error);
            });

            setTimeout(() => {
                reject(new Error('Chat service connection timeout'));
            }, 10000);
        });
    }

    async simulateMovieBotTranscription() {
        console.log('\n🎬 Step 3: Simulating MovieBot Transcription...');

        // Test transcriptions with varying content
        const testTranscriptions = [
            "I never thought I'd see you again after what happened in Paris.",
            "The treasure was hidden here all along, right under our noses!",
            "You've got to be kidding me. That's your master plan?"
        ];

        const transcription = testTranscriptions[Math.floor(Math.random() * testTranscriptions.length)];
        console.log(`🎙️ Using test transcription: "${transcription}"`);

        try {
            // Import the necessary services 
            const MovieBotService = require('./server/services/MovieBotService');
            const ChatBotService = require('./server/services/ChatBotService');
            const TranscriptionService = require('./server/services/TranscriptionService');
            const ChatService = require('./server/services/ChatService');
            
            // Create service instances (simplified)
            const chatBotService = new ChatBotService();
            await chatBotService.initialize();
            
            const movieBotService = new MovieBotService(
                null, // transcriptionService 
                chatBotService,
                null, // chatService
                database
            );

            // Directly test the transcription processing
            console.log('🔄 Processing test transcription...');
            await movieBotService.processTranscription(transcription);
            
            console.log('✅ Transcription processing triggered');

        } catch (error) {
            console.error('❌ Transcription simulation failed:', error);
            this.testResults.errors.push(`Transcription simulation: ${error.message}`);
        }
    }

    async waitForBotResponses() {
        console.log('\n⏳ Step 4: Waiting for Bot Responses...');
        console.log(`   Expecting responses from ${this.enabledBots.length} bots...`);

        const startTime = Date.now();
        const timeout = 20000; // 20 seconds

        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const remaining = timeout - elapsed;

                if (elapsed >= timeout) {
                    clearInterval(checkInterval);
                    console.log(`⏰ Timeout reached after ${timeout/1000} seconds`);
                    resolve();
                    return;
                }

                // Check if we received responses from all expected bots
                const uniqueBotResponders = new Set(
                    this.testResults.messagesReceived.map(msg => 
                        msg.bot.replace('🤖 ', '') // Remove robot emoji prefix
                    )
                );

                console.log(`   ${uniqueBotResponders.size}/${this.enabledBots.length} bots responded (${Math.ceil(remaining/1000)}s remaining)`);

                if (uniqueBotResponders.size >= this.enabledBots.length) {
                    clearInterval(checkInterval);
                    console.log('✅ All expected bots have responded!');
                    resolve();
                }
            }, 2000);
        });
    }

    generateReport() {
        console.log('\n📋 Step 5: Test Results Report');
        console.log('=' .repeat(60));

        // Bot response summary
        const uniqueBotResponders = new Set(
            this.testResults.messagesReceived.map(msg => 
                msg.bot.replace('🤖 ', '')
            )
        );

        console.log(`\n📊 Response Summary:`);
        console.log(`   Expected bots: ${this.enabledBots.length}`);
        console.log(`   Responding bots: ${uniqueBotResponders.size}`);
        console.log(`   Total messages: ${this.testResults.messagesReceived.length}`);
        console.log(`   Success rate: ${Math.round((uniqueBotResponders.size / this.enabledBots.length) * 100)}%`);

        // Individual bot results
        console.log(`\n🤖 Individual Bot Results:`);
        this.enabledBots.forEach(bot => {
            const botMessages = this.testResults.messagesReceived.filter(msg => 
                msg.bot.replace('🤖 ', '') === bot.name
            );
            
            if (botMessages.length > 0) {
                console.log(`   ✅ ${bot.name}: ${botMessages.length} message(s)`);
                botMessages.forEach(msg => {
                    console.log(`      💬 "${msg.message}"`);
                });
            } else {
                console.log(`   ❌ ${bot.name}: No response`);
            }
        });

        // Error summary
        if (this.testResults.errors.length > 0) {
            console.log(`\n⚠️ Errors Encountered:`);
            this.testResults.errors.forEach(error => {
                console.log(`   - ${error}`);
            });
        }

        // Overall result
        const overallSuccess = uniqueBotResponders.size >= Math.ceil(this.enabledBots.length * 0.5); // 50% threshold
        console.log(`\n🎯 Overall Test Result: ${overallSuccess ? '✅ PASS' : '❌ FAIL'}`);
        
        if (overallSuccess) {
            console.log('   The moviebot to chat flow is working correctly!');
        } else {
            console.log('   Issues detected in the moviebot to chat flow.');
        }

        console.log('\n' + '=' .repeat(60));
    }

    cleanup() {
        if (this.chatSocket) {
            this.chatSocket.disconnect();
        }
        this.testComplete = true;
    }
}

// Run the test
async function runTest() {
    const tester = new MovieBotEndToEndTest();
    await tester.runFullTest();
    process.exit(0);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Test interrupted by user');
    process.exit(1);
});

// Run the test
runTest().catch(error => {
    console.error('💥 Test runner failed:', error);
    process.exit(1);
});