const { io: ioClient } = require('socket.io-client');

// Test configuration
const CHAT_SERVICE_URL = 'http://localhost:8081';

class MovieBotBatchingTest {
    constructor() {
        this.messagesReceived = [];
        this.chatSocket = null;
        this.expectedBots = ['TheInventor', 'TheArtist', 'TheScholar', 'TheComedian', 'TheMystic', 'TheStrategist'];
        this.botCategories = {
            'quick_reactors': ['TheComedian', 'TheInventor'],
            'deep_thinkers': ['TheScholar', 'TheMystic'],
            'creative_minds': ['TheArtist', 'TheStrategist']
        };
    }

    async runTest() {
        console.log('🧪 MovieBot Batching Test - Monitoring for New System Behavior...');
        console.log('=' .repeat(70));
        console.log('📋 Bot Categories:');
        Object.entries(this.botCategories).forEach(([category, bots]) => {
            console.log(`   ${category}: ${bots.join(', ')}`);
        });
        console.log('=' .repeat(70));

        try {
            await this.connectToChatService();
            console.log('✅ Connected to chat service, monitoring for improved moviebot behavior...');
            console.log('🔍 Looking for:');
            console.log('   • Different bot subsets responding to different transcripts');
            console.log('   • Staggered message timing (2-6 second delays)');
            console.log('   • 15-second transcription chunks');
            console.log('   • Multiple transcriptions per cycle');
            console.log('\n⏱️ Monitoring for 45 seconds...\n');
            
            // Monitor for 45 seconds to see multiple cycles
            await this.monitorChatMessages(45000);
            
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
                    username: 'BatchingTestObserver',
                    color: '#00FF00',
                    isBot: false
                });

                // Listen for new messages
                this.chatSocket.on('new-message', (message) => {
                    // Check if this is from one of our expected bots
                    const botName = message.username.replace('🤖 ', '');
                    const isBotMessage = this.expectedBots.includes(botName);
                    
                    if (isBotMessage) {
                        const timestamp = new Date().toLocaleTimeString();
                        console.log(`📨 [${timestamp}] ${message.username}: "${message.message}"`);
                        
                        // Determine which category this bot belongs to
                        let category = 'unknown';
                        for (const [cat, bots] of Object.entries(this.botCategories)) {
                            if (bots.includes(botName)) {
                                category = cat;
                                break;
                            }
                        }
                        
                        this.messagesReceived.push({
                            bot: botName,
                            message: message.message,
                            timestamp: new Date(),
                            fullMessage: message,
                            category: category
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
                
                // Log progress less frequently for longer test
                if (remaining % 10000 < 1000) { // Log every 10 seconds
                    const uniqueBots = new Set(this.messagesReceived.map(msg => msg.bot));
                    console.log(`⏳ ${Math.ceil(remaining/1000)}s remaining... ${uniqueBots.size} unique bots, ${this.messagesReceived.length} total messages`);
                }
            }, 1000);
        });
    }

    generateReport() {
        console.log('\n📋 Batching Test Results Report');
        console.log('=' .repeat(70));

        const uniqueBots = new Set(this.messagesReceived.map(msg => msg.bot));
        const totalMessages = this.messagesReceived.length;

        console.log(`\n📊 Overall Summary:`);
        console.log(`   Active bots: ${uniqueBots.size}/${this.expectedBots.length}`);
        console.log(`   Total messages: ${totalMessages}`);

        // Analyze message timing patterns
        if (this.messagesReceived.length > 1) {
            console.log(`\n⏱️ Message Timing Analysis:`);
            const timeDiffs = [];
            for (let i = 1; i < this.messagesReceived.length; i++) {
                const diff = this.messagesReceived[i].timestamp - this.messagesReceived[i-1].timestamp;
                timeDiffs.push(diff);
            }
            
            const avgDelay = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
            const minDelay = Math.min(...timeDiffs);
            const maxDelay = Math.max(...timeDiffs);
            
            console.log(`   Average delay between messages: ${Math.round(avgDelay)}ms`);
            console.log(`   Min delay: ${minDelay}ms`);
            console.log(`   Max delay: ${maxDelay}ms`);
            
            // Check if delays are in expected range (2-6 seconds)
            const staggeredMessages = timeDiffs.filter(diff => diff >= 2000 && diff <= 6000).length;
            const staggeringScore = Math.round((staggeredMessages / timeDiffs.length) * 100);
            console.log(`   Messages with proper staggering (2-6s): ${staggeredMessages}/${timeDiffs.length} (${staggeringScore}%)`);
        }

        // Analyze category distribution
        console.log(`\n🎯 Category Distribution:`);
        const categoryStats = {};
        this.messagesReceived.forEach(msg => {
            if (!categoryStats[msg.category]) {
                categoryStats[msg.category] = [];
            }
            categoryStats[msg.category].push(msg);
        });

        Object.entries(categoryStats).forEach(([category, messages]) => {
            const uniqueBotsInCategory = new Set(messages.map(m => m.bot));
            console.log(`   ${category}: ${messages.length} messages from ${uniqueBotsInCategory.size} bots`);
            console.log(`      Bots: ${Array.from(uniqueBotsInCategory).join(', ')}`);
        });

        // Look for batching patterns (groups of messages from same category)
        console.log(`\n🔄 Batching Pattern Analysis:`);
        if (this.messagesReceived.length >= 2) {
            let currentBatch = [this.messagesReceived[0]];
            const batches = [];
            
            for (let i = 1; i < this.messagesReceived.length; i++) {
                const timeDiff = this.messagesReceived[i].timestamp - this.messagesReceived[i-1].timestamp;
                
                // If messages are within 10 seconds and same category, consider them part of the same batch
                if (timeDiff < 10000 && this.messagesReceived[i].category === this.messagesReceived[i-1].category) {
                    currentBatch.push(this.messagesReceived[i]);
                } else {
                    batches.push(currentBatch);
                    currentBatch = [this.messagesReceived[i]];
                }
            }
            batches.push(currentBatch);
            
            console.log(`   Detected ${batches.length} message batches:`);
            batches.forEach((batch, index) => {
                const category = batch[0].category;
                const botNames = batch.map(m => m.bot).join(', ');
                console.log(`      Batch ${index + 1}: ${batch.length} messages from '${category}' (${botNames})`);
            });
        }

        // Assessment
        console.log(`\n🎯 System Assessment:`);
        
        const improvements = [];
        const issues = [];
        
        if (uniqueBots.size > 0) {
            improvements.push('✅ Bots are actively responding to movie content');
        } else {
            issues.push('❌ No bot activity detected');
        }
        
        if (totalMessages >= 3) {
            improvements.push('✅ Multiple messages generated (suggests multiple transcriptions)');
        }
        
        const categoryCount = Object.keys(categoryStats).length;
        if (categoryCount > 1) {
            improvements.push(`✅ Multiple bot categories active (${categoryCount} categories)`);
        } else if (categoryCount === 1) {
            improvements.push('⚠️ Only one bot category active (may be expected for short test)');
        }
        
        // Print results
        if (improvements.length > 0) {
            console.log('   Improvements observed:');
            improvements.forEach(imp => console.log(`      ${imp}`));
        }
        
        if (issues.length > 0) {
            console.log('   Issues detected:');
            issues.forEach(issue => console.log(`      ${issue}`));
        }
        
        if (uniqueBots.size >= 2 && categoryCount >= 2) {
            console.log(`\n🎉 Result: ✅ GOOD - Batching system appears to be working!`);
        } else if (uniqueBots.size > 0) {
            console.log(`\n🤔 Result: ⚠️ PARTIAL - Some activity detected, may need more time to see full batching`);
        } else {
            console.log(`\n😞 Result: ❌ NO ACTIVITY - Check if moviebot is currently enabled`);
        }

        console.log('\n' + '=' .repeat(70));
    }

    cleanup() {
        if (this.chatSocket) {
            this.chatSocket.disconnect();
        }
    }
}

// Run the test
async function runTest() {
    const tester = new MovieBotBatchingTest();
    await tester.runTest();
    process.exit(0);
}

runTest().catch(error => {
    console.error('💥 Test failed:', error);
    process.exit(1);
});