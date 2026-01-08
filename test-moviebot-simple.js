const { io: ioClient } = require('socket.io-client');
const axios = require('axios');

// Test configuration
const MAIN_SERVER_URL = 'http://localhost:8080';
const CHAT_SERVICE_URL = 'http://localhost:8081';

class SimpleMovieBotTest {
    constructor() {
        this.messagesReceived = [];
        this.chatSocket = null;
        this.expectedBots = ['TheInventor', 'TheArtist', 'TheScholar', 'TheComedian', 'TheMystic', 'TheStrategist'];
    }

    async runTest() {
        console.log('🧪 Simple MovieBot Test - Monitoring Chat for Bot Messages...');
        console.log('=' .repeat(60));

        try {
            await this.connectToChatService();
            console.log('✅ Connected to chat service, monitoring for moviebot messages...');
            console.log('   Expected bots:', this.expectedBots.join(', '));
            console.log('   Monitoring for 30 seconds...');
            
            // Monitor for 30 seconds
            await this.monitorChatMessages(30000);
            
            this.generateReport();
            
        } catch (error) {
            console.error('❌ Test failed:', error);
        } finally {
            this.cleanup();
        }
    }

    async connectToChatService() {
        return new Promise((resolve, reject) => {
            this.chatSocket = ioClient(CHAT_SERVICE_URL, {
                transports: ['websocket']
            });

            this.chatSocket.on('connect', () => {
                // Join chat as test observer
                this.chatSocket.emit('join-chat', {
                    username: 'TestObserver',
                    color: '#FF0000',
                    isBot: false
                });

                // Listen for new messages
                this.chatSocket.on('new-message', (message) => {
                    // Check if this is from one of our expected bots
                    const botName = message.username.replace('🤖 ', '');
                    const isBotMessage = this.expectedBots.includes(botName);
                    
                    if (isBotMessage) {
                        console.log(`📨 [${new Date().toLocaleTimeString()}] ${message.username}: "${message.message}"`);
                        this.messagesReceived.push({
                            bot: botName,
                            message: message.message,
                            timestamp: new Date().toISOString(),
                            fullMessage: message
                        });
                    }
                });

                // Listen for chat history to see existing messages
                this.chatSocket.on('chat-history', (messages) => {
                    console.log(`📜 Received chat history with ${messages.length} messages`);
                    
                    // Check for recent bot messages in history
                    const recentBotMessages = messages.filter(msg => {
                        const botName = msg.username.replace('🤖 ', '');
                        return this.expectedBots.includes(botName);
                    }).slice(-10); // Last 10 bot messages
                    
                    if (recentBotMessages.length > 0) {
                        console.log('📋 Recent bot messages found in history:');
                        recentBotMessages.forEach(msg => {
                            console.log(`   ${msg.username}: "${msg.message}" (${msg.timestamp})`);
                        });
                    }
                });

                resolve();
            });

            this.chatSocket.on('connect_error', (error) => {
                reject(error);
            });

            setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 10000);
        });
    }

    async monitorChatMessages(duration) {
        const startTime = Date.now();
        
        return new Promise((resolve) => {
            const interval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const remaining = duration - elapsed;
                
                if (elapsed >= duration) {
                    clearInterval(interval);
                    resolve();
                    return;
                }
                
                const uniqueBots = new Set(this.messagesReceived.map(msg => msg.bot));
                if (remaining % 5000 < 1000) { // Log every 5 seconds
                    console.log(`⏳ Monitoring... ${uniqueBots.size}/${this.expectedBots.length} bots seen (${Math.ceil(remaining/1000)}s remaining)`);
                }
            }, 1000);
        });
    }

    generateReport() {
        console.log('\n📋 Test Results Report');
        console.log('=' .repeat(60));

        const uniqueBots = new Set(this.messagesReceived.map(msg => msg.bot));
        const successRate = Math.round((uniqueBots.size / this.expectedBots.length) * 100);

        console.log(`\n📊 Summary:`);
        console.log(`   Expected bots: ${this.expectedBots.length}`);
        console.log(`   Active bots: ${uniqueBots.size}`);
        console.log(`   Total messages: ${this.messagesReceived.length}`);
        console.log(`   Success rate: ${successRate}%`);

        console.log(`\n🤖 Bot Activity:`);
        this.expectedBots.forEach(botName => {
            const botMessages = this.messagesReceived.filter(msg => msg.bot === botName);
            if (botMessages.length > 0) {
                console.log(`   ✅ ${botName}: ${botMessages.length} message(s)`);
                // Show most recent message
                const latest = botMessages[botMessages.length - 1];
                console.log(`      Latest: "${latest.message}"`);
            } else {
                console.log(`   ❌ ${botName}: No messages seen`);
            }
        });

        // Overall assessment
        if (uniqueBots.size >= Math.ceil(this.expectedBots.length * 0.5)) {
            console.log(`\n🎯 Result: ✅ PASS - MovieBot system is working!`);
            console.log('   Bots are successfully generating movie comments and sending them to chat.');
        } else if (uniqueBots.size > 0) {
            console.log(`\n🎯 Result: ⚠️ PARTIAL - Some bots are working`);
            console.log('   Some bots are responding but others may have issues.');
        } else {
            console.log(`\n🎯 Result: ❌ FAIL - No bot activity detected`);
            console.log('   Check if moviebot is enabled and running.');
        }

        console.log('\n' + '=' .repeat(60));
    }

    cleanup() {
        if (this.chatSocket) {
            this.chatSocket.disconnect();
        }
    }
}

// Run the test
async function runTest() {
    const tester = new SimpleMovieBotTest();
    await tester.runTest();
    process.exit(0);
}

runTest().catch(error => {
    console.error('💥 Test failed:', error);
    process.exit(1);
});