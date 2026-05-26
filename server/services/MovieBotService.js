const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

class MovieBotService extends EventEmitter {
    constructor(transcriptionService, chatBotService, chatService, database, botEventBus = null) {
        super();
        this.transcriptionService = transcriptionService;
        this.chatBotService = chatBotService;
        this.chatService = chatService;
        this.database = database;
        this.db = database.db;
        // PR 1.3: ChatBotService no longer calls addChatMessage directly.
        // Subscribe to 'chat-message' events from the shared BotEventBus.
        this.botEventBus = botEventBus;
        
        // Store recent chat messages for movie context
        this.recentChatMessages = [];
        this.MAX_CHAT_HISTORY = 50;
        
        // Set up direct listener for chat messages
        this.setupChatListener();
        
        // Configuration - will be loaded from database or use defaults
        this.config = null; // Will be initialized from database in loadConfigFromDatabase()
        this.defaultPromptTemplate = `You are watching a stream. Your core identity is that you are currently a viewer of this stream watching the content. You will actively comment on what's happening in the stream. Read through the chatlogs above to pick out details about what people think about the stream content. Respond to those comments or respond to what is actively happening in the stream. The most important information you need is the last 45-seconds of audio from the stream. Incorporate a direct response to this transcription, or incorporate the context of it within your next message. Here is the transcription:

[TRANSCRIPTION_DATA]`;
        
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
        
        // Load configuration from database on initialization
        // Delay loading to ensure database is ready
        setTimeout(() => {
            this.loadConfigFromDatabase();
        }, 100);
        
        console.log('🎬 MovieBotService: Initialized');
    }
    
    ensureLogDirectory() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }
    
    loadConfigFromDatabase() {
        if (!this.db) {
            console.log('⚠️ MovieBotService: Database not ready, using defaults');
            this.config = {
                enabled: false,
                transcriptionDuration: 45,
                transcriptionFrequency: 120,
                chatHistoryLimit: 30,
                useGroq: false,
                messageDelay: {
                    min: 4000,
                    max: 8000
                },
                moviePromptTemplate: this.defaultPromptTemplate
            };
            return;
        }
        
        this.db.get(`SELECT * FROM moviebot_config WHERE id = 1`, (err, row) => {
            if (err) {
                console.error('❌ MovieBotService: Error loading config from database:', err);
                return;
            }
            
            if (row) {
                console.log('📚 MovieBotService: Loading config from database, row:', row);
                this.config = {
                    enabled: row.enabled === 1, // Load enabled state from database
                    streamerId: row.streamer_id || null,
                    transcriptionDuration: row.transcription_duration || 45,
                    transcriptionFrequency: row.transcription_frequency || 120,
                    chatHistoryLimit: row.chat_history_limit || 30,
                    useGroq: row.use_groq === 1,
                    messageDelay: {
                        min: row.message_delay_min || 4000,
                        max: row.message_delay_max || 8000
                    },
                    moviePromptTemplate: row.movie_prompt_template || this.defaultPromptTemplate
                };
                
                // Also update the Groq API key if present
                if (row.groq_api_key && this.chatBotService?.llmService) {
                    this.chatBotService.llmService.groqApiKey = row.groq_api_key;
                    if (this.config.useGroq) {
                        this.chatBotService.llmService.enableGroq(row.groq_api_key);
                        console.log('✅ MovieBotService: Groq enabled from database config');
                    }
                }
                
                console.log('✅ MovieBotService: Config loaded from database', {
                    enabled: this.config.enabled,
                    useGroq: this.config.useGroq,
                    hasApiKey: !!row.groq_api_key,
                    rowUseGroq: row.use_groq,
                    hasChatBotService: !!this.chatBotService,
                    hasLLMService: !!this.chatBotService?.llmService
                });

                // If enabled in database, restore active state
                if (this.config.enabled && this.config.streamerId) {
                    console.log(`🔄 MovieBotService: Enabled state found in database for streamer ${this.config.streamerId}, restoring active state`);
                    this.isActive = true;
                    this.currentStreamerId = this.config.streamerId;
                    // Schedule the first transcription
                    this.scheduleNextTranscription();
                } else if (this.config.enabled && !this.config.streamerId) {
                    console.log('⚠️ MovieBotService: Enabled in database but no streamer_id found, waiting for manual enable');
                }
            } else {
                console.log('📝 MovieBotService: No saved config found, creating defaults');
                // Create default config
                this.config = {
                    enabled: false,
                    transcriptionDuration: 45,
                    transcriptionFrequency: 120,
                    chatHistoryLimit: 30,
                    useGroq: false,
                    messageDelay: {
                        min: 4000,
                        max: 8000
                    },
                    moviePromptTemplate: this.defaultPromptTemplate
                };
                this.saveConfigToDatabase();
            }
        });
    }
    
    saveConfigToDatabase(includeApiKey = false, apiKey = null) {
        if (!this.db) {
            console.log('⚠️ MovieBotService: Database not ready, cannot save config');
            return;
        }
        
        const query = includeApiKey && apiKey ? `
            INSERT OR REPLACE INTO moviebot_config (
                id, enabled, streamer_id, use_groq, groq_api_key, transcription_duration,
                transcription_frequency, chat_history_limit,
                message_delay_min, message_delay_max, movie_prompt_template,
                updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ` : `
            UPDATE moviebot_config SET
                enabled = ?,
                streamer_id = ?,
                use_groq = ?,
                transcription_duration = ?,
                transcription_frequency = ?,
                chat_history_limit = ?,
                message_delay_min = ?,
                message_delay_max = ?,
                movie_prompt_template = ?,
                updated_at = datetime('now')
            WHERE id = 1
        `;

        const params = includeApiKey && apiKey ? [
            this.config.enabled ? 1 : 0,
            this.currentStreamerId || null,
            this.config.useGroq ? 1 : 0,
            apiKey,
            this.config.transcriptionDuration,
            this.config.transcriptionFrequency,
            this.config.chatHistoryLimit,
            this.config.messageDelay.min,
            this.config.messageDelay.max,
            this.config.moviePromptTemplate || this.defaultPromptTemplate
        ] : [
            this.config.enabled ? 1 : 0,
            this.currentStreamerId || null,
            this.config.useGroq ? 1 : 0,
            this.config.transcriptionDuration,
            this.config.transcriptionFrequency,
            this.config.chatHistoryLimit,
            this.config.messageDelay.min,
            this.config.messageDelay.max,
            this.config.moviePromptTemplate || this.defaultPromptTemplate
        ];
        
        this.db.run(query, params, (err) => {
            if (err) {
                console.error('❌ MovieBotService: Error saving config to database:', err);
            } else {
                console.log('💾 MovieBotService: Config saved to database');
            }
        });
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

        // Save enabled state to database
        this.saveConfigToDatabase();

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

        // Save disabled state to database
        this.saveConfigToDatabase();

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
        
        // Use the frequency setting (convert seconds to milliseconds)
        const delay = this.config.transcriptionFrequency * 1000;
        
        console.log(`⏱️ MovieBotService: Next transcription in ${this.config.transcriptionFrequency}s`);
        
        this.transcriptionTimer = setTimeout(() => {
            console.log(`🔥 MovieBotService: Timer executed! Starting transcription`);
            this.captureAndProcessTranscription();
        }, delay);
        
        console.log(`🔧 MovieBotService: Timer ID: ${this.transcriptionTimer}`);
    }
    
    // Simplified - no longer using cycles, just single transcriptions on a frequency
    
    async captureAndProcessTranscription() {
        if (!this.isActive || !this.currentStreamerId) {
            console.log('⚠️ MovieBotService: Not active or no streamer');
            return;
        }
        
        console.log(`🎙️ MovieBotService: Starting ${this.config.transcriptionDuration}-second transcription`);
        
        try {
            // Start a timed transcription
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
                // Schedule next transcription anyway
                this.scheduleNextTranscription();
                return;
            }
            
            const sessionId = transcriptionResult.sessionId;
            this.currentSessions.push(sessionId);
            
            // Wait for transcription to complete
            console.log(`🎧 MovieBotService: Waiting for transcription to complete (session ${sessionId})`);
            this.transcriptionService.once('transcription-stopped', async (data) => {
                console.log(`🔔 MovieBotService: Received transcription-stopped event:`, data.sessionId);
                if (data.sessionId === sessionId) {
                    console.log(`📝 MovieBotService: Transcription completed (${data.wordCount} words)`);

                    // Remove from active sessions
                    const sessionIndex = this.currentSessions.indexOf(sessionId);
                    if (sessionIndex > -1) {
                        this.currentSessions.splice(sessionIndex, 1);
                    }

                    // Get the transcription text from event or fallback to database
                    let transcription = data.transcription;
                    if (!transcription) {
                        transcription = await this.getTranscriptionText(data.sessionId);
                    }

                    if (transcription) {
                        console.log(`📝 MovieBotService: Processing transcription: "${transcription.substring(0, 100)}..."`);
                        // Process the transcription and trigger chatbots
                        await this.processTranscriptionWithBatching(transcription, 0);
                    } else {
                        console.log(`⚠️ MovieBotService: No transcription text available`);
                    }

                    // Schedule the next transcription
                    this.scheduleNextTranscription();
                }
            });
            
        } catch (error) {
            console.error('❌ MovieBotService: Error capturing transcription:', error);
            // Schedule next transcription anyway
            this.scheduleNextTranscription();
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
            
            // Use ALL enabled MovieBots (no more category system)
            const targetBots = allMovieBotEnabledBots;
            
            console.log(`🎯 MovieBotService: Using all ${targetBots.length} enabled MovieBots: ${targetBots.map(b => b.name).join(', ')}`);
            
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
            console.log(`🎬 MovieBotService: Scheduled ${targetBots.length} MovieBots to respond`);
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
        } else {
            chatContext = '\n\nRecent chat messages:\n(No recent messages available)\n';
        }
        
        // Replace placeholder with actual transcription
        const moviePrompt = this.config.moviePromptTemplate.replace(
            '[TRANSCRIPTION_DATA]',
            transcriptionText
        );
        
        // Combine all prompts
        const fullPrompt = `${globalPrompt}${chatContext}\n\n${moviePrompt}`;
        
        // Debug log the prompt
        console.log('🎬 MovieBotService: Building movie prompt:');
        console.log('   - Transcription length:', transcriptionText.length);
        console.log('   - Chat history count:', chatHistory ? chatHistory.length : 0);
        console.log('   - Full prompt preview:', fullPrompt.substring(0, 200) + '...');
        
        return fullPrompt;
    }
    
    async getChatHistory(limit = 30) {
        try {
            // First try to get messages from memory
            let messages = this.recentChatMessages.slice(-limit);
            
            // If no messages in memory, try to get from database
            if (messages.length === 0) {
                console.log('💬 MovieBotService: No messages in memory, fetching from database...');
                messages = await this.getChatHistoryFromDatabase(limit);
            }
            
            console.log(`💬 MovieBotService: Returning ${messages.length} chat messages for context`);
            
            // Debug: Log the actual messages
            if (messages.length > 0) {
                console.log('   Recent messages:');
                messages.slice(-5).forEach(msg => {
                    console.log(`     - ${msg.username}: ${msg.message.substring(0, 50)}${msg.message.length > 50 ? '...' : ''}`);
                });
            } else {
                console.log('   ⚠️ No recent chat messages available!');
                // Return some default context
                messages = [
                    { username: 'viewer1', message: 'watching the stream', timestamp: new Date() },
                    { username: 'viewer2', message: 'cool content', timestamp: new Date() }
                ];
                console.log('   Using default context messages');
            }
            
            return messages;
        } catch (error) {
            console.error('❌ MovieBotService: Failed to get chat history:', error);
            return [];
        }
    }
    
    async getChatHistoryFromDatabase(limit = 30) {
        try {
            // Try to get recent messages from the database
            const query = `
                SELECT username, message, created_at as timestamp 
                FROM messages 
                WHERE username NOT LIKE '%🤖%'
                ORDER BY created_at DESC 
                LIMIT ?
            `;
            
            return new Promise((resolve) => {
                this.db.all(query, [limit], (err, rows) => {
                    if (err) {
                        console.error('❌ MovieBotService: Error fetching messages from database:', err);
                        resolve([]);
                    } else {
                        const messages = rows ? rows.reverse().map(row => ({
                            username: row.username,
                            message: row.message,
                            timestamp: row.timestamp
                        })) : [];
                        console.log(`   Fetched ${messages.length} messages from database`);
                        resolve(messages);
                    }
                });
            });
        } catch (error) {
            console.error('❌ MovieBotService: Failed to query database:', error);
            return [];
        }
    }
    
    setupChatListener() {
        // PR 1.3 path: subscribe to the BotEventBus for chat messages.
        // ChatBotService emits 'chat-message' whenever its bot socket
        // receives a new chat line; this replaces the direct
        // chatBot.movieBotService.addChatMessage(...) call from the
        // pre-1.3 wiring. Handler is stored on this so a future stop()
        // can removeListener it cleanly. addChatMessage itself filters
        // bot usernames (line ~798), so no prefilter here.
        if (this.botEventBus) {
            console.log('🎬 MovieBotService: Subscribing to BotEventBus chat-message events');
            this._onBusChatMessage = ({ username, message }) => {
                if (username && message) {
                    this.addChatMessage(username, message);
                }
            };
            this.botEventBus.on('chat-message', this._onBusChatMessage);
        }

        // Legacy path: some test/dev setups pass a chatService with .on().
        // The production chatServiceWrapper from bootstrap/services.js does
        // NOT have .on() (it only exposes getRecentMessages), so the
        // production path never entered this branch — but the warning log
        // is preserved for setups that genuinely use an emitter-shaped
        // chat service.
        if (this.chatService && this.chatService.on) {
            console.log('🎬 MovieBotService: Setting up legacy chatService listener');
            this.chatService.on('message', (data) => {
                if (data.username && data.message && !data.username.includes('🤖')) {
                    this.addChatMessage(data.username, data.message);
                }
            });
        } else if (!this.botEventBus) {
            console.log('⚠️ MovieBotService: No chat source available (no BotEventBus, no chatService.on)');
        }
    }
    
    // Method to add chat messages from the chat service
    addChatMessage(username, message) {
        // Don't store bot messages to avoid recursive responses
        if (!username.includes('🤖')) {
            console.log(`📝 MovieBotService: Adding chat message from ${username}: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);
            
            this.recentChatMessages.push({
                username: username,
                message: message,
                timestamp: new Date()
            });
            
            // Keep only the most recent messages
            if (this.recentChatMessages.length > this.MAX_CHAT_HISTORY) {
                this.recentChatMessages = this.recentChatMessages.slice(-this.MAX_CHAT_HISTORY);
            }
            
            console.log(`   Total messages stored: ${this.recentChatMessages.length}`);
        } else {
            console.log(`🤖 MovieBotService: Skipping bot message from ${username}`);
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
        // If config not initialized, load from database first
        if (!this.config) {
            this.loadConfigFromDatabase();
        }
        
        // Always return a valid status with config from database or defaults
        return {
            enabled: this.config?.enabled || false,
            isActive: this.isActive || false,
            currentStreamerId: this.currentStreamerId || null,
            currentSession: this.currentSession || null,
            config: this.config || {
                enabled: false,
                transcriptionDuration: 45,
                transcriptionFrequency: 120,
                chatHistoryLimit: 30,
                useGroq: false,
                messageDelay: {
                    min: 4000,
                    max: 8000
                }
            },
            recentPrompts: this.promptHistory?.slice(-10) || []
        };
    }
    
    updateConfig(newConfig) {
        // Initialize config from database if it doesn't exist
        if (!this.config) {
            this.loadConfigFromDatabase();
            // If still no config after loading, use defaults
            if (!this.config) {
                this.config = {
                    enabled: false,
                    transcriptionDuration: 45,
                    transcriptionFrequency: 120,
                    chatHistoryLimit: 30,
                    useGroq: false,
                    messageDelay: {
                        min: 4000,
                        max: 8000
                    }
                };
            }
        }
        
        console.log('🔧 MovieBotService: Updating config with:', newConfig);
        
        if (newConfig.transcriptionDuration !== undefined) {
            this.config.transcriptionDuration = newConfig.transcriptionDuration;
        }
        if (newConfig.transcriptionFrequency !== undefined) {
            this.config.transcriptionFrequency = newConfig.transcriptionFrequency;
        }
        if (newConfig.chatHistoryLimit !== undefined) {
            this.config.chatHistoryLimit = newConfig.chatHistoryLimit;
        }
        if (newConfig.moviePromptTemplate !== undefined) {
            this.config.moviePromptTemplate = newConfig.moviePromptTemplate;
        }
        if (newConfig.groqApiKey !== undefined && this.chatBotService && this.chatBotService.llmService) {
            // Update the API key
            this.chatBotService.llmService.groqApiKey = newConfig.groqApiKey;
            console.log('🔑 MovieBotService: Groq API key updated');
        }
        
        if (newConfig.useGroq !== undefined) {
            this.config.useGroq = newConfig.useGroq;
            console.log(`🚀 MovieBotService: useGroq changed to ${newConfig.useGroq}`);
            
            // Enable/disable Groq in the ChatBotService
            if (this.chatBotService && this.chatBotService.llmService) {
                if (newConfig.useGroq) {
                    const success = this.chatBotService.llmService.enableGroq(newConfig.groqApiKey);
                    if (success) {
                        console.log('✅ MovieBotService: Groq API enabled successfully');
                    } else {
                        console.log('⚠️ MovieBotService: Failed to enable Groq (API key missing?)');
                        this.config.useGroq = false; // Revert if failed
                    }
                } else {
                    this.chatBotService.llmService.disableGroq();
                    console.log('✅ MovieBotService: Groq API disabled');
                }
            } else {
                console.log('⚠️ MovieBotService: ChatBotService or LLMService not available yet');
            }
        }
        
        // Save configuration to database
        const saveWithApiKey = newConfig.groqApiKey !== undefined;
        this.saveConfigToDatabase(saveWithApiKey, newConfig.groqApiKey);
        
        console.log('🎬 MovieBotService: Configuration updated, current config:', this.config);
        this.logEvent('CONFIG_UPDATED', newConfig);
        
        return { success: true, config: this.config };
    }
    
    getRecentLogs(limit = 50) {
        return this.promptHistory.slice(-limit);
    }
}

module.exports = MovieBotService;