const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

class MovieBotService extends EventEmitter {
    constructor(transcriptionService, chatBotService, chatService, database) {
        super();
        this.transcriptionService = transcriptionService;
        this.chatBotService = chatBotService;
        this.chatService = chatService;
        this.database = database;
        this.db = database.db;
        
        // Store recent chat messages for movie context
        this.recentChatMessages = [];
        this.MAX_CHAT_HISTORY = 50;
        
        // Configuration
        this.config = {
            enabled: false,
            transcriptionDuration: 15, // 15-second chunks (increased from 10)
            minInterval: 60000, // 60 seconds minimum between cycles
            maxInterval: 120000, // 120 seconds maximum between cycles
            chatHistoryLimit: 30, // Last 30 messages
            transcriptionsPerCycle: 3, // Number of transcriptions per cycle
            timeBetweenTranscriptions: 25000, // 25 seconds between transcriptions (ensures batches don't overlap)
            messageDelay: {
                min: 4000, // 4 seconds minimum delay between bot messages
                max: 8000  // 8 seconds maximum delay between bot messages
            },
            batchSpacing: 20000, // 20 seconds minimum between batch completions
            moviePromptTemplate: `You are watching a film. Your core identity is that you are currently a viewer of this stream who is watching the film. You will actively comment on the film as it progresses. Read through the chatlogs above to pick out details about what people think about the movie. Respond to those or respond to what is actively happening in the film. The most important information you need is the last 15-seconds of audio from the film. Incorporate a direct response to this transcription, or incorporate the context of it within your next message. Here is the transcription:

[TRANSCRIPTION_DATA]`
        };
        
        // Bot categorization for batching - will be dynamically assigned
        this.botCategories = {
            'quick_reactors': [], // React quickly to dialogue
            'deep_thinkers': [],  // Analyze and reflect
            'creative_minds': []  // Creative interpretations
        };
        
        // Static mapping for known bots (fallback/preferred assignments)
        this.preferredBotCategories = {
            'TheComedian': 'quick_reactors',
            'TheInventor': 'quick_reactors',
            'TheScholar': 'deep_thinkers',
            'TheMystic': 'deep_thinkers',
            'TheArtist': 'creative_minds',
            'TheStrategist': 'creative_minds'
        };
        
        // State
        this.isActive = false;
        this.currentSessions = []; // Track multiple concurrent transcriptions
        this.transcriptionTimer = null;
        this.currentStreamerId = null;
        this.promptHistory = [];
        this.currentCycleIndex = 0; // Track which transcription cycle we're on
        
        // Log directory
        this.logDir = path.join(__dirname, '..', '..', 'logs', 'moviebot');
        this.ensureLogDirectory();
        
        console.log('🎬 MovieBotService: Initialized');
    }
    
    ensureLogDirectory() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }
    
    async enable(streamerId) {
        console.log(`🔧 MovieBotService: enable() called with streamerId: ${streamerId}`);
        console.log(`🔧 MovieBotService: Current state - isActive: ${this.isActive}, currentStreamerId: ${this.currentStreamerId}`);
        
        if (this.isActive) {
            console.log('⚠️ MovieBotService: Already active');
            return { success: false, error: 'MovieBot is already active' };
        }
        
        console.log(`🎬 MovieBotService: Enabling for streamer ${streamerId}`);
        
        this.isActive = true;
        this.currentStreamerId = streamerId;
        this.config.enabled = true;
        
        console.log(`🔧 MovieBotService: State updated - isActive: ${this.isActive}, currentStreamerId: ${this.currentStreamerId}`);
        
        // Start the first transcription after a random delay
        console.log(`🔧 MovieBotService: About to call scheduleNextTranscription()`);
        this.scheduleNextTranscription();
        
        // Emit event
        this.emit('moviebot-enabled', {
            streamerId: streamerId,
            timestamp: new Date()
        });
        
        // Log the enablement
        this.logEvent('ENABLED', {
            streamerId: streamerId,
            config: this.config
        });
        
        console.log(`🎬 MovieBotService: MovieBot enabled successfully for streamer ${streamerId}`);
        return { success: true, message: 'MovieBot enabled successfully' };
    }
    
    async disable() {
        if (!this.isActive) {
            console.log('⚠️ MovieBotService: Not currently active');
            return { success: false, error: 'MovieBot is not active' };
        }
        
        console.log('🎬 MovieBotService: Disabling');
        
        this.isActive = false;
        this.config.enabled = false;
        
        // Clear any pending transcription timer
        if (this.transcriptionTimer) {
            clearTimeout(this.transcriptionTimer);
            this.transcriptionTimer = null;
        }
        
        // Stop current transcription if active
        if (this.currentSession) {
            await this.stopCurrentTranscription();
        }
        
        // Emit event
        this.emit('moviebot-disabled', {
            timestamp: new Date()
        });
        
        // Log the disablement
        this.logEvent('DISABLED', {});
        
        this.currentStreamerId = null;
        
        return { success: true, message: 'MovieBot disabled successfully' };
    }
    
    scheduleNextTranscription() {
        console.log(`🔧 MovieBotService: scheduleNextTranscription called - isActive: ${this.isActive}, currentStreamerId: ${this.currentStreamerId}`);
        
        if (!this.isActive) {
            console.log(`⚠️ MovieBotService: Not active, skipping scheduling`);
            return;
        }
        
        // Random interval between min and max
        const delay = Math.floor(
            Math.random() * (this.config.maxInterval - this.config.minInterval) + 
            this.config.minInterval
        );
        
        console.log(`⏱️ MovieBotService: Next transcription cycle in ${delay / 1000}s`);
        console.log(`🔧 MovieBotService: Will capture ${this.config.transcriptionsPerCycle} transcriptions with ${this.config.timeBetweenTranscriptions/1000}s between them`);
        
        this.transcriptionTimer = setTimeout(() => {
            console.log(`🔥 MovieBotService: Timer executed! Starting transcription cycle`);
            this.startTranscriptionCycle();
        }, delay);
        
        console.log(`🔧 MovieBotService: Timer ID: ${this.transcriptionTimer}`);
    }
    
    async startTranscriptionCycle() {
        if (!this.isActive || !this.currentStreamerId) {
            console.log('⚠️ MovieBotService: Not active or no streamer during cycle start');
            return;
        }
        
        console.log(`🎬 MovieBotService: Starting transcription cycle (${this.config.transcriptionsPerCycle} transcriptions)`);
        console.log(`   Transcriptions will be captured every ${this.config.timeBetweenTranscriptions/1000}s`);
        console.log(`   Bot responses will be staggered ${this.config.messageDelay.min/1000}-${this.config.messageDelay.max/1000}s apart`);
        
        // Reset cycle index
        this.currentCycleIndex = 0;
        
        // Start the first transcription immediately
        await this.captureAndProcessTranscription();
        
        // Schedule remaining transcriptions in the cycle with proper spacing
        for (let i = 1; i < this.config.transcriptionsPerCycle; i++) {
            setTimeout(async () => {
                if (this.isActive && this.currentStreamerId) {
                    this.currentCycleIndex = i;
                    await this.captureAndProcessTranscription();
                }
            }, i * this.config.timeBetweenTranscriptions);
        }
        
        // Calculate when all batches will be complete (including message delays)
        const totalCycleTime = this.config.transcriptionsPerCycle * this.config.timeBetweenTranscriptions;
        const bufferTime = this.config.batchSpacing; // Extra time to ensure all messages are sent
        
        // Schedule the next complete cycle
        setTimeout(() => {
            console.log(`⏰ MovieBotService: Cycle complete, scheduling next cycle`);
            this.scheduleNextTranscription();
        }, totalCycleTime + bufferTime);
    }
    
    async captureAndProcessTranscription() {
        if (!this.isActive || !this.currentStreamerId) {
            console.log('⚠️ MovieBotService: Not active or no streamer');
            return;
        }
        
        console.log(`🎙️ MovieBotService: Starting ${this.config.transcriptionDuration}-second transcription (cycle ${this.currentCycleIndex + 1}/${this.config.transcriptionsPerCycle})`);
        
        try {
            // Start a timed transcription for 15 seconds
            const transcriptionResult = await this.transcriptionService.startTimedTranscription(
                this.currentStreamerId,
                this.config.transcriptionDuration,
                {
                    model: 'base',
                    language: 'en'
                }
            );
            
            if (!transcriptionResult.success) {
                console.error('❌ MovieBotService: Failed to start transcription:', transcriptionResult.error);
                return; // Don't reschedule here, let the cycle complete
            }
            
            const sessionId = transcriptionResult.sessionId;
            this.currentSessions.push(sessionId);
            
            // Wait for transcription to complete (will auto-stop after 15 seconds)
            this.transcriptionService.once('transcription-stopped', async (data) => {
                if (data.sessionId === sessionId) {
                    console.log(`📝 MovieBotService: Transcription ${this.currentCycleIndex + 1} completed (${data.wordCount} words)`);
                    
                    // Remove from active sessions
                    const sessionIndex = this.currentSessions.indexOf(sessionId);
                    if (sessionIndex > -1) {
                        this.currentSessions.splice(sessionIndex, 1);
                    }
                    
                    // Get the transcription text
                    const transcription = await this.getTranscriptionText(data.sessionId);
                    
                    if (transcription) {
                        // Process the transcription and trigger chatbot with bot batching
                        await this.processTranscriptionWithBatching(transcription, this.currentCycleIndex);
                    }
                }
            });
            
        } catch (error) {
            console.error('❌ MovieBotService: Error capturing transcription:', error);
        }
    }
    
    async getTranscriptionText(sessionId) {
        try {
            const transcription = await this.transcriptionService.getTranscription(sessionId);
            if (transcription && transcription.full_text) {
                return transcription.full_text.trim();
            }
            return null;
        } catch (error) {
            console.error('❌ MovieBotService: Failed to get transcription text:', error);
            return null;
        }
    }
    
    async processTranscription(transcriptionText) {
        // Validate transcription has meaningful content
        if (!transcriptionText || typeof transcriptionText !== 'string') {
            console.log('⚠️ MovieBotService: No transcription text provided, skipping');
            return;
        }
        
        const cleanText = transcriptionText.trim();
        if (cleanText.length < 10) {
            console.log(`⚠️ MovieBotService: Transcription too short (${cleanText.length} chars), skipping`);
            return;
        }
        
        // Check for meaningful content (not just "you" or common hallucinations)
        const meaningfulWords = cleanText.toLowerCase().split(/\s+/).filter(word => 
            word.length > 2 && 
            !['you', 'the', 'and', 'but', 'for', 'are', 'with', 'his', 'they', 'this', 'have', 'from', 'one', 'had', 'word', 'not', 'what', 'all', 'were', 'can', 'said', 'there', 'each', 'which', 'she', 'their', 'time', 'will', 'way', 'about', 'out', 'many', 'then', 'them', 'these', 'some', 'her', 'would', 'make', 'like', 'into', 'him', 'has', 'two', 'more', 'very', 'after', 'first', 'well', 'how', 'now', 'been', 'may', 'come', 'its'].includes(word)
        );
        
        if (meaningfulWords.length < 3) {
            console.log(`⚠️ MovieBotService: Transcription lacks meaningful content (${meaningfulWords.length} meaningful words), skipping`);
            console.log(`   Text: "${cleanText}"`);
            return;
        }
        
        console.log(`🎬 MovieBotService: Processing transcription (${cleanText.length} chars, ${meaningfulWords.length} meaningful words)`);
        console.log(`   Preview: "${cleanText.substring(0, 100)}${cleanText.length > 100 ? '...' : ''}"`);
        
        try {
            // Get recent chat history (simplified to avoid errors)
            const chatHistory = await this.getChatHistory(this.config.chatHistoryLimit);
            
            // Get all bots with MovieBot enabled
            const movieBotEnabledBots = await this.chatBotService.getMovieBotEnabledBots();
            if (movieBotEnabledBots.length === 0) {
                console.log('⚠️ MovieBotService: No chatbots with MovieBot enabled');
                return;
            }
            
            console.log(`🎬 MovieBotService: Found ${movieBotEnabledBots.length} bots with MovieBot enabled`);
            
            // Build the movie commentary prompt with cleaned transcription
            const moviePrompt = this.buildMoviePrompt(cleanText, chatHistory);
            
            // Send prompt to all MovieBot-enabled bots
            const responses = [];
            for (const bot of movieBotEnabledBots) {
                console.log(`🤖 MovieBotService: Sending prompt to bot: ${bot.username}`);
                
                try {
                    // Log the full prompt for this bot
                    this.logPrompt(bot.username, moviePrompt, cleanText);
                    
                    // Trigger the chatbot with the movie prompt
                    const response = await this.chatBotService.generateMovieComment(
                        bot,
                        moviePrompt,
                        chatHistory
                    );
                    
                    if (response && response.success && response.message) {
                        console.log(`✅ MovieBotService: Bot ${bot.username} generated comment: "${response.message}"`);
                        responses.push({
                            bot: bot.username,
                            comment: response.message
                        });
                        
                        // Log the bot's response
                        this.logBotResponse(bot.username, cleanText, response.message);
                        
                        // Emit event for UI updates
                        this.emit('moviebot-comment', {
                            bot: bot.username,
                            transcription: cleanText,
                            comment: response.message,
                            timestamp: new Date()
                        });
                    } else {
                        const errorMsg = response?.error || 'No response generated';
                        console.log(`⚠️ MovieBotService: Bot ${bot.username} failed to generate comment: ${errorMsg}`);
                        this.logBotError(bot.username, cleanText, errorMsg);
                    }
                } catch (error) {
                    console.error(`❌ MovieBotService: Error with bot ${bot.username}:`, error);
                    this.logBotError(bot.username, cleanText, error.message);
                }
            }
            
            console.log(`🎬 MovieBotService: ${responses.length}/${movieBotEnabledBots.length} bots responded`);
            
        } catch (error) {
            console.error('❌ MovieBotService: Error processing transcription:', error);
        }
    }
    
    // Dynamically assign bots to categories based on who's online
    assignBotsToCategories(availableBots) {
        // Reset categories
        this.botCategories = {
            'quick_reactors': [],
            'deep_thinkers': [],
            'creative_minds': []
        };
        
        const unassignedBots = [];
        
        // First pass: assign bots to their preferred categories if they exist
        for (const bot of availableBots) {
            const preferredCategory = this.preferredBotCategories[bot.name];
            if (preferredCategory) {
                this.botCategories[preferredCategory].push(bot.name);
            } else {
                unassignedBots.push(bot.name);
            }
        }
        
        // Second pass: distribute unassigned bots evenly across categories
        const categories = Object.keys(this.botCategories);
        let categoryIndex = 0;
        
        for (const botName of unassignedBots) {
            // Find the category with the fewest bots
            let minCategory = categories[0];
            let minCount = this.botCategories[minCategory].length;
            
            for (const category of categories) {
                if (this.botCategories[category].length < minCount) {
                    minCount = this.botCategories[category].length;
                    minCategory = category;
                }
            }
            
            this.botCategories[minCategory].push(botName);
            console.log(`🤖 MovieBotService: Dynamically assigned ${botName} to category '${minCategory}'`);
        }
        
        // Log the final distribution
        console.log('📊 MovieBotService: Bot category assignments:');
        for (const [category, bots] of Object.entries(this.botCategories)) {
            if (bots.length > 0) {
                console.log(`   ${category}: ${bots.join(', ')}`);
            }
        }
        
        return this.botCategories;
    }
    
    async processTranscriptionWithBatching(transcriptionText, cycleIndex) {
        // Validate transcription has meaningful content
        if (!transcriptionText || typeof transcriptionText !== 'string') {
            console.log('⚠️ MovieBotService: No transcription text provided, skipping');
            return;
        }
        
        const cleanText = transcriptionText.trim();
        if (cleanText.length < 10) {
            console.log(`⚠️ MovieBotService: Transcription too short (${cleanText.length} chars), skipping`);
            return;
        }
        
        // Check for meaningful content
        const meaningfulWords = cleanText.toLowerCase().split(/\s+/).filter(word => 
            word.length > 2 && 
            !['you', 'the', 'and', 'but', 'for', 'are', 'with', 'his', 'they', 'this', 'have', 'from', 'one', 'had', 'word', 'not', 'what', 'all', 'were', 'can', 'said', 'there', 'each', 'which', 'she', 'their', 'time', 'will', 'way', 'about', 'out', 'many', 'then', 'them', 'these', 'some', 'her', 'would', 'make', 'like', 'into', 'him', 'has', 'two', 'more', 'very', 'after', 'first', 'well', 'how', 'now', 'been', 'may', 'come', 'its'].includes(word)
        );
        
        if (meaningfulWords.length < 3) {
            console.log(`⚠️ MovieBotService: Transcription lacks meaningful content (${meaningfulWords.length} meaningful words), skipping`);
            console.log(`   Text: "${cleanText}"`);
            return;
        }
        
        console.log(`🎬 MovieBotService: Processing transcription ${cycleIndex + 1} with batching (${cleanText.length} chars, ${meaningfulWords.length} meaningful words)`);
        console.log(`   Preview: "${cleanText.substring(0, 100)}${cleanText.length > 100 ? '...' : ''}"`);
        
        try {
            // Get recent chat history
            const chatHistory = await this.getChatHistory(this.config.chatHistoryLimit);
            
            // Get all bots with MovieBot enabled
            const allMovieBotEnabledBots = await this.chatBotService.getMovieBotEnabledBots();
            if (allMovieBotEnabledBots.length === 0) {
                console.log('⚠️ MovieBotService: No chatbots with MovieBot enabled');
                return;
            }
            
            // Dynamically assign bots to categories based on who's currently online
            this.assignBotsToCategories(allMovieBotEnabledBots);
            
            // Determine which bot category to use for this cycle
            const categoryNames = Object.keys(this.botCategories).filter(cat => this.botCategories[cat].length > 0);
            if (categoryNames.length === 0) {
                console.log('⚠️ MovieBotService: No categories have bots assigned');
                return;
            }
            
            const selectedCategory = categoryNames[cycleIndex % categoryNames.length];
            const categoryBots = this.botCategories[selectedCategory];
            
            // Filter to only bots that are both in the category and enabled
            const targetBots = allMovieBotEnabledBots.filter(bot => 
                categoryBots.includes(bot.name)
            );
            
            if (targetBots.length === 0) {
                console.log(`⚠️ MovieBotService: No enabled bots found for category '${selectedCategory}'`);
                return;
            }
            
            console.log(`🎯 MovieBotService: Targeting category '${selectedCategory}' with bots: ${targetBots.map(b => b.name).join(', ')}`);
            
            // Build the movie commentary prompt
            const moviePrompt = this.buildMoviePrompt(cleanText, chatHistory);
            
            // Send prompts to bots in the selected category with staggered timing
            const responses = [];
            let cumulativeDelay = 0; // Track cumulative delay to ensure sequential responses
            
            for (let i = 0; i < targetBots.length; i++) {
                const bot = targetBots[i];
                
                // Calculate delay for this bot (stagger messages)
                // First bot responds immediately, others wait progressively longer
                if (i > 0) {
                    const delayRange = this.config.messageDelay.max - this.config.messageDelay.min;
                    const randomDelay = Math.floor(Math.random() * delayRange) + this.config.messageDelay.min;
                    cumulativeDelay += randomDelay;
                }
                
                const botDelay = cumulativeDelay;
                
                // Schedule the bot response with cumulative delay
                setTimeout(async () => {
                    try {
                        console.log(`🤖 MovieBotService: Sending delayed prompt to bot: ${bot.username} (${botDelay}ms delay)`);
                        
                        // Log the full prompt for this bot
                        this.logPrompt(bot.username, moviePrompt, cleanText);
                        
                        // Trigger the chatbot with the movie prompt
                        const response = await this.chatBotService.generateMovieComment(
                            bot,
                            moviePrompt,
                            chatHistory
                        );
                        
                        if (response && response.success && response.message) {
                            console.log(`✅ MovieBotService: Bot ${bot.username} generated comment: "${response.message}"`);
                            responses.push({
                                bot: bot.username,
                                comment: response.message
                            });
                            
                            // Log the bot's response
                            this.logBotResponse(bot.username, cleanText, response.message);
                            
                            // Emit event for UI updates
                            this.emit('moviebot-comment', {
                                bot: bot.username,
                                transcription: cleanText,
                                comment: response.message,
                                timestamp: new Date(),
                                category: selectedCategory,
                                cycleIndex: cycleIndex
                            });
                        } else {
                            const errorMsg = response?.error || 'No response generated';
                            console.log(`⚠️ MovieBotService: Bot ${bot.username} failed to generate comment: ${errorMsg}`);
                            this.logBotError(bot.username, cleanText, errorMsg);
                        }
                    } catch (error) {
                        console.error(`❌ MovieBotService: Error with bot ${bot.username}:`, error);
                        this.logBotError(bot.username, cleanText, error.message);
                    }
                }, botDelay);
            }
            
            const totalBatchTime = cumulativeDelay / 1000;
            console.log(`🎬 MovieBotService: Scheduled ${targetBots.length} bots from category '${selectedCategory}'`);
            console.log(`   Total batch duration: ~${totalBatchTime}s (last bot responds after ${cumulativeDelay}ms)`);
            
        } catch (error) {
            console.error('❌ MovieBotService: Error processing transcription with batching:', error);
        }
    }
    
    buildMoviePrompt(transcriptionText, chatHistory) {
        // Get the global prompt from chatbot service
        const globalPrompt = this.chatBotService.getGlobalPrompt();
        
        // Build chat history context
        let chatContext = '';
        if (chatHistory && chatHistory.length > 0) {
            chatContext = '\n\nRecent chat messages:\n';
            chatHistory.forEach(msg => {
                chatContext += `${msg.username}: ${msg.message}\n`;
            });
        }
        
        // Replace placeholder with actual transcription
        const moviePrompt = this.config.moviePromptTemplate.replace(
            '[TRANSCRIPTION_DATA]',
            transcriptionText
        );
        
        // Combine all prompts
        const fullPrompt = `${globalPrompt}${chatContext}\n\n${moviePrompt}`;
        
        return fullPrompt;
    }
    
    async getChatHistory(limit = 30) {
        try {
            // Return the most recent chat messages
            const messages = this.recentChatMessages.slice(-limit);
            console.log(`💬 MovieBotService: Returning ${messages.length} chat messages for context`);
            return messages;
        } catch (error) {
            console.error('❌ MovieBotService: Failed to get chat history:', error);
            return [];
        }
    }
    
    // Method to add chat messages from the chat service
    addChatMessage(username, message) {
        // Don't store bot messages to avoid recursive responses
        if (!username.includes('🤖')) {
            this.recentChatMessages.push({
                username: username,
                message: message,
                timestamp: new Date()
            });
            
            // Keep only the most recent messages
            if (this.recentChatMessages.length > this.MAX_CHAT_HISTORY) {
                this.recentChatMessages = this.recentChatMessages.slice(-this.MAX_CHAT_HISTORY);
            }
        }
    }
    
    async stopCurrentTranscription() {
        // Stop all active transcription sessions
        if (this.currentSessions && this.currentSessions.length > 0) {
            try {
                console.log(`🛑 MovieBotService: Stopping ${this.currentSessions.length} active transcription sessions`);
                
                for (const sessionId of this.currentSessions) {
                    try {
                        await this.transcriptionService.stopTranscription(sessionId);
                        console.log(`✅ MovieBotService: Stopped transcription session ${sessionId}`);
                    } catch (error) {
                        console.error(`❌ MovieBotService: Error stopping session ${sessionId}:`, error);
                    }
                }
                
                this.currentSessions = [];
            } catch (error) {
                console.error('❌ MovieBotService: Error stopping transcriptions:', error);
            }
        }
        
        // Legacy support - clean up old single session variable if it exists
        if (this.currentSession) {
            try {
                await this.transcriptionService.stopTranscription(this.currentSession);
                this.currentSession = null;
            } catch (error) {
                console.error('❌ MovieBotService: Error stopping legacy transcription session:', error);
            }
        }
    }
    
    logEvent(eventType, data) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            event: eventType,
            data: data
        };
        
        // Log to file
        const logFile = path.join(this.logDir, `moviebot_${new Date().toISOString().split('T')[0]}.log`);
        fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
        
        // Keep in memory for recent access
        this.promptHistory.push(logEntry);
        if (this.promptHistory.length > 100) {
            this.promptHistory.shift();
        }
    }
    
    logPrompt(botUsername, fullPrompt, transcriptionText) {
        const promptLog = {
            timestamp: new Date().toISOString(),
            event: 'PROMPT_SENT',
            bot: botUsername,
            transcription: transcriptionText,
            fullPrompt: fullPrompt,
            promptLength: fullPrompt.length
        };
        
        // Log to file with full prompt details
        const logFile = path.join(
            this.logDir, 
            `prompts_${new Date().toISOString().split('T')[0]}.log`
        );
        fs.appendFileSync(logFile, JSON.stringify(promptLog, null, 2) + '\n---\n');
        
        // Console log summary
        console.log(`📋 MovieBotService: Logged prompt for ${botUsername}`);
        console.log(`   Prompt length: ${fullPrompt.length} chars`);
        console.log(`   Transcription length: ${transcriptionText.length} chars`);
        
        // Keep in memory for recent access
        this.promptHistory.push(promptLog);
        if (this.promptHistory.length > 100) {
            this.promptHistory.shift();
        }
        
        // Emit for UI monitoring
        this.emit('prompt-logged', promptLog);
    }
    
    logBotResponse(botUsername, transcriptionText, responseMessage) {
        const responseLog = {
            timestamp: new Date().toISOString(),
            event: 'BOT_RESPONSE',
            bot: botUsername,
            transcription: transcriptionText,
            response: responseMessage,
            responseLength: responseMessage.length
        };
        
        // Log to file
        const logFile = path.join(
            this.logDir, 
            `responses_${new Date().toISOString().split('T')[0]}.log`
        );
        fs.appendFileSync(logFile, JSON.stringify(responseLog, null, 2) + '\n---\n');
        
        // Console log
        console.log(`✅ MovieBotService: Bot ${botUsername} responded with ${responseMessage.length} chars`);
        
        // Keep in memory for recent access
        this.promptHistory.push(responseLog);
        if (this.promptHistory.length > 100) {
            this.promptHistory.shift();
        }
        
        // Emit for UI monitoring
        this.emit('response-logged', responseLog);
    }
    
    logBotError(botUsername, transcriptionText, errorMessage) {
        const errorLog = {
            timestamp: new Date().toISOString(),
            event: 'BOT_ERROR',
            bot: botUsername,
            transcription: transcriptionText,
            error: errorMessage
        };
        
        // Log to file
        const logFile = path.join(
            this.logDir, 
            `errors_${new Date().toISOString().split('T')[0]}.log`
        );
        fs.appendFileSync(logFile, JSON.stringify(errorLog, null, 2) + '\n---\n');
        
        // Keep in memory for recent access
        this.promptHistory.push(errorLog);
        if (this.promptHistory.length > 100) {
            this.promptHistory.shift();
        }
        
        // Emit for UI monitoring
        this.emit('error-logged', errorLog);
    }
    
    getStatus() {
        return {
            enabled: this.config.enabled,
            isActive: this.isActive,
            currentStreamerId: this.currentStreamerId,
            currentSession: this.currentSession,
            config: this.config,
            recentPrompts: this.promptHistory.slice(-10)
        };
    }
    
    updateConfig(newConfig) {
        if (newConfig.transcriptionDuration !== undefined) {
            this.config.transcriptionDuration = newConfig.transcriptionDuration;
        }
        if (newConfig.minInterval !== undefined) {
            this.config.minInterval = newConfig.minInterval;
        }
        if (newConfig.maxInterval !== undefined) {
            this.config.maxInterval = newConfig.maxInterval;
        }
        if (newConfig.chatHistoryLimit !== undefined) {
            this.config.chatHistoryLimit = newConfig.chatHistoryLimit;
        }
        if (newConfig.moviePromptTemplate !== undefined) {
            this.config.moviePromptTemplate = newConfig.moviePromptTemplate;
        }
        
        console.log('🎬 MovieBotService: Configuration updated');
        this.logEvent('CONFIG_UPDATED', newConfig);
        
        return { success: true, config: this.config };
    }
    
    getRecentLogs(limit = 50) {
        return this.promptHistory.slice(-limit);
    }
}

module.exports = MovieBotService;