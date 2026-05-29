const { io: ioClient } = require('socket.io-client');
const ChatBotLLMService = require('./ChatBotLLMService');
const ChatBotRepository = require('../database/repository/ChatBotRepository');

const logger = require('../bootstrap/logger').child({ svc: 'ChatBotService' });
const { ANIMALS, COLORS } = require('./chatbot/botIdentity');

class ChatBotService {
    /**
     * @param {object} [deps]
     * @param {object} [deps.botEventBus]            - BotEventBus instance (PR 1.3 path)
     * @param {Function} [deps.getMoviePromptTemplate] - factory closure for movie prompt
     * @param {ChatBotRepository} [deps.chatBotRepository] - inject a custom
     *   repository for tests. Defaults to a fresh `ChatBotRepository()` so
     *   the existing `new ChatBotService({ ... })` callsites work unchanged.
     */
    constructor({ botEventBus = null, getMoviePromptTemplate = null, chatBotRepository = null } = {}) {
        this.bots = new Map(); // botId -> BotInstance
        this.llmService = new ChatBotLLMService();
        this.repo = chatBotRepository || new ChatBotRepository();
        this.chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';
        this.isInitialized = false;
        this.io = null; // Reference to Socket.IO server instance for managing connections
        // BotEventBus is the post-PR-1.3 path for ChatBot → MovieBot signaling.
        // Falls back to null when not injected (the test mocks don't pass one);
        // emit() guards on truthiness so the no-bus case is a silent no-op.
        this.botEventBus = botEventBus;
        // PR-M4 (ADR-0013): optional ModerationService reference. When set,
        // every MovieBot reply runs through `checkBotOutput()` before it's
        // emitted to chat — flagged outputs are dropped silently and a
        // 'mb_output_dropped' moderation_events row is written. Late-
        // injected from server/index.js via setModerationService() because
        // ModerationService is built after ChatBotService.
        this.moderationService = null;
        // getMoviePromptTemplate is a closure provided by the factory that
        // lazily reads movieBotService.config.moviePromptTemplate at call
        // time (movieBotService is constructed AFTER chatBotService, so the
        // closure captures it by reference and resolves it on use). Keeps
        // the temporary-bot prompt aligned with MovieBot's admin-editable
        // config without re-introducing a construction-time dependency.
        this.getMoviePromptTemplate = getMoviePromptTemplate;
        
        // Auto-initialize after a short delay to ensure server is ready
        setTimeout(() => {
            if (!this.isInitialized) {
                logger.debug('🤖 AUTO-INIT: Starting delayed ChatBot initialization...');
                this.initialize().catch(err => {
                    logger.error('❌ AUTO-INIT: Failed to auto-initialize ChatBots:', err);
                });
            }
        }, 10000); // 10 second delay to let server stabilize
        
        // Animal names for random usernames (matching chat service)
        this.ANIMALS = ANIMALS;
        
        // Color palette for usernames
        this.COLORS = COLORS;
    }

    async initialize() {
        if (this.isInitialized) return;
        
        try {
            logger.debug('🤖 INIT: Starting ChatBot Service initialization...');
            
            // Load and start all enabled bots
            const bots = await this.repo.getEnabled();
            
            logger.debug(`🤖 INIT: Found ${bots.length} enabled bots in database`);
            bots.forEach(bot => logger.debug(`   - Bot ${bot.id}: ${bot.name}`));
            
            for (const bot of bots) {
                logger.debug(`🤖 INIT: Starting bot ${bot.id} (${bot.name})`);
                await this.startBot(bot);
                logger.debug(`🤖 INIT: Bot ${bot.id} started, bots Map size is now: ${this.bots.size}`);
            }
            
            this.isInitialized = true;
            logger.debug(`✅ ChatBot Service initialized with ${bots.length} bots`);
            logger.debug(`🤖 INIT: Final bots Map size: ${this.bots.size}`);
            logger.debug(`🤖 INIT: Final bots Map keys: ${Array.from(this.bots.keys())}`);
        } catch (error) {
            logger.error('❌ ChatBot Service initialization error:', error);
        }
    }

    setModerationService(moderationService) {
        this.moderationService = moderationService || null;
    }

    setIoInstance(io) {
        this.io = io;
        logger.debug('🤖 ChatBot Service: Socket.IO instance set for managing connections');
    }

    generateUsername(customName = null) {
        if (customName && customName.trim()) {
            return customName.trim();
        }
        
        const animal = this.ANIMALS[Math.floor(Math.random() * this.ANIMALS.length)];
        const number = Math.floor(Math.random() * 9999) + 1;
        return `${animal}${number}`;
    }

    generateColor() {
        return this.COLORS[Math.floor(Math.random() * this.COLORS.length)];
    }

    async createBot(data) {
        try {
            const result = await this.repo.create({
                name: data.name || this.generateUsername(),
                prompt: data.prompt || 'You are a friendly chat participant.',
                is_enabled: data.is_enabled !== undefined ? data.is_enabled : 1,
                response_interval_min: data.response_interval_min || 60,
                response_interval_max: data.response_interval_max || 180,
                show_robot_emoji: data.show_robot_emoji !== undefined ? data.show_robot_emoji : 1,
                personality_traits: JSON.stringify(data.personality_traits || {}),
                use_assigned_name: data.use_assigned_name !== undefined ? data.use_assigned_name : 1,
                llm_model: data.llm_model || null,  // null means use global default
                moviebot_enabled: data.moviebot_enabled !== undefined ? data.moviebot_enabled : 0,
                vision_bot_enabled: data.vision_bot_enabled !== undefined ? data.vision_bot_enabled : 0,
                response_creativity_temperature: data.response_creativity_temperature !== undefined ? data.response_creativity_temperature : 0.7,
            });

            const bot = await this.repo.getById(result.id);

            if (bot.is_enabled) {
                await this.startBot(bot);
            }

            return bot;
        } catch (error) {
            logger.error('Error creating bot:', error);
            throw error;
        }
    }

    async updateBot(id, data) {
        try {
            // Convert id to number for consistency with the Map keys
            const botId = parseInt(id);

            // Whitelist of mutable columns. Anything not in this map is
            // silently dropped — the repo would happily SET ?=? on any
            // key passed, so the whitelist is the request-side guard.
            const fields = {};
            if (data.name !== undefined) fields.name = data.name;
            if (data.prompt !== undefined) fields.prompt = data.prompt;
            if (data.is_enabled !== undefined) fields.is_enabled = data.is_enabled;
            if (data.response_interval_min !== undefined) fields.response_interval_min = data.response_interval_min;
            if (data.response_interval_max !== undefined) fields.response_interval_max = data.response_interval_max;
            if (data.show_robot_emoji !== undefined) fields.show_robot_emoji = data.show_robot_emoji;
            if (data.personality_traits !== undefined) fields.personality_traits = JSON.stringify(data.personality_traits);
            if (data.use_assigned_name !== undefined) fields.use_assigned_name = data.use_assigned_name;
            if (data.llm_model !== undefined) fields.llm_model = data.llm_model || null;
            if (data.moviebot_enabled !== undefined) fields.moviebot_enabled = data.moviebot_enabled;
            if (data.vision_bot_enabled !== undefined) fields.vision_bot_enabled = data.vision_bot_enabled;
            if (data.response_creativity_temperature !== undefined) fields.response_creativity_temperature = data.response_creativity_temperature;

            await this.repo.updateFields(botId, fields);

            const bot = await this.repo.getById(botId);
            
            // Restart bot if it's running (use numeric id for Map lookup)
            if (this.bots.has(botId)) {
                await this.stopBot(botId);
            }
            
            if (bot.is_enabled) {
                await this.startBot(bot);
            }
            
            return bot;
        } catch (error) {
            logger.error('Error updating bot:', error);
            throw error;
        }
    }

    async deleteBot(id) {
        try {
            const botId = parseInt(id);
            await this.stopBot(botId);
            await this.repo.deleteById(botId);
            return { success: true };
        } catch (error) {
            logger.error('Error deleting bot:', error);
            throw error;
        }
    }

    async getAllBots() {
        try {
            const bots = await this.repo.getAll();

            // Add runtime status and last message for each bot
            const botsWithStatus = await Promise.all(bots.map(async (bot) => {
                const lastMessage = await this.repo.getLastMessageForBot(bot.id);
                const tempBotInfo = await this.repo.getTemporaryBotInfo(bot.id);
                
                let additionalInfo = {};
                if (tempBotInfo) {
                    const now = Date.now();
                    const expiresAt = new Date(tempBotInfo.expires_at).getTime();
                    const timeRemaining = Math.max(0, Math.floor((expiresAt - now) / 1000));
                    
                    additionalInfo = {
                        is_temporary: true,
                        summoned_by: tempBotInfo.summoned_by_username,
                        summoned_by_user_id: tempBotInfo.summoned_by_user_id,
                        personality_prompt: tempBotInfo.personality_prompt,
                        expires_at: tempBotInfo.expires_at,
                        time_remaining_seconds: timeRemaining,
                        time_remaining_display: this.formatTimeRemaining(timeRemaining)
                    };
                }
                
                return {
                    ...bot,
                    is_connected: this.bots.has(bot.id) && this.bots.get(bot.id).connected,
                    personality_traits: bot.personality_traits ? JSON.parse(bot.personality_traits) : {},
                    moviebot_enabled: bot.moviebot_enabled === 1 || bot.moviebot_enabled === true,
                    vision_bot_enabled: bot.vision_bot_enabled === 1 || bot.vision_bot_enabled === true,
                    last_message: lastMessage ? lastMessage.message : null,
                    last_message_at: lastMessage ? lastMessage.created_at : null,
                    ...additionalInfo
                };
            }));
            
            return botsWithStatus;
        } catch (error) {
            logger.error('Error getting bots:', error);
            throw error;
        }
    }
    
    formatTimeRemaining(seconds) {
        if (seconds <= 0) return 'Expired';
        
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    async startBot(botData) {
        logger.debug(`🤖 START: Attempting to start bot ${botData.id} (${botData.name})`);
        logger.debug(`🤖 START: Current bots Map has bot ${botData.id}: ${this.bots.has(botData.id)}`);
        
        if (this.bots.has(botData.id)) {
            logger.debug(`🤖 START: Bot ${botData.id} already running, skipping`);
            return;
        }

        // Use assigned name if enabled, otherwise generate random name
        // SQLite returns 1/0 for booleans, convert to proper boolean
        const useAssignedName = botData.use_assigned_name === 1 || botData.use_assigned_name === true;
        const username = useAssignedName ? 
            botData.name : 
            this.generateUsername(null);
        // Use consistent color based on bot ID
        const color = this.COLORS[botData.id % this.COLORS.length];
        
        const botInstance = {
            id: botData.id,
            data: botData,
            username,
            color,
            socket: null,
            connected: false,
            messageHistory: [],
            responseTimer: null,
            sessionId: null
        };

        // Connect to chat service
        logger.debug(`🤖 Attempting to connect bot ${botData.name} to ${this.chatServiceUrl}`);
        const socket = ioClient(this.chatServiceUrl, {
            path: '/chat/socket.io',
            transports: ['websocket'],
            query: {
                isBot: true,
                botId: botData.id
            },
            rejectUnauthorized: false // Allow self-signed certificates
        });
        
        // Store socket immediately for tracking
        botInstance.socket = socket;

        socket.on('connect', async () => {
            logger.debug(`🤖 Bot ${botData.name} connected as ${username} to chat service`);
            logger.debug(`🤖 Socket ID: ${socket.id}, Connected: ${socket.connected}`);
            botInstance.connected = true;
            
            // Store session in database
            const session = await this.repo.createSession({
                chatbotId: botData.id,
                socketId: socket.id,
                username,
                color,
            });
            botInstance.sessionId = session.id;
            
            // Join chat with bot metadata
            socket.emit('join-chat', {
                username: botData.show_robot_emoji ? `🤖 ${username}` : username,
                color: color,
                isBot: true
            });
            
            // Start response cycle
            logger.debug(`🤖 Bot ${botData.name} starting response cycle`);
            this.scheduleNextResponse(botInstance);
        });

        socket.on('chat-history', (messages) => {
            botInstance.messageHistory = messages || [];
        });

        socket.on('new-message', (message) => {
            // Don't respond to own messages or system messages
            if (message.username === username || 
                message.username === `🤖 ${username}` || 
                message.isSystem) {
                return;
            }
            
            // Add to history
            botInstance.messageHistory.push(message);
            if (botInstance.messageHistory.length > 30) {
                botInstance.messageHistory.shift();
            }
            
            // Feed to MovieBotService via the BotEventBus. Decoupled in PR 1.3
            // so this service no longer holds a direct MovieBotService ref;
            // the factory wires the same bus into both subscribers.
            if (this.botEventBus && message.username && message.message) {
                this.botEventBus.emit('chat-message', {
                    username: message.username,
                    message: message.message,
                });
            }
        });

        socket.on('connect_error', (error) => {
            logger.error(`❌ Bot ${botData.name} connection error:`, error.message);
            logger.error(`   Chat service URL: ${this.chatServiceUrl}`);
            logger.error(`   Make sure chat service is running on port 8081`);
        });

        socket.on('disconnect', () => {
            logger.debug(`🤖 Bot ${botData.name} disconnected`);
            botInstance.connected = false;
            
            if (botInstance.responseTimer) {
                clearTimeout(botInstance.responseTimer);
            }
            
            // Mark session as disconnected
            if (botInstance.sessionId) {
                this.repo.markSessionDisconnected(botInstance.sessionId);
            }
        });

        botInstance.socket = socket;
        this.bots.set(botData.id, botInstance);
        logger.debug(`🤖 START: Bot ${botData.id} added to bots Map. New size: ${this.bots.size}`);
    }

    async stopBot(id) {
        const bot = this.bots.get(id);
        if (!bot) return;

        logger.debug(`🛑 Stopping bot ${id} (${bot.data?.name})`);

        if (bot.responseTimer) {
            clearTimeout(bot.responseTimer);
            bot.responseTimer = null;
        }

        if (bot.socket) {
            bot.socket.disconnect();
            bot.socket = null;
        }

        // Remove bot from the Map - CRITICAL FIX
        this.bots.delete(id);
        logger.debug(`🗑️ Bot ${id} removed from bots Map. Remaining bots: ${this.bots.size}`);

        // Clean up session
        await this.repo.deleteSessionsForBot(id);
    }

    scheduleNextResponse(botInstance) {
        logger.debug(`🤖 scheduleNextResponse called for bot ${botInstance.id}: connected=${botInstance.connected}, enabled=${botInstance.data.is_enabled}`);
        if (!botInstance.connected || !botInstance.data.is_enabled) {
            logger.debug(`🤖 Bot ${botInstance.id} not scheduling - connected: ${botInstance.connected}, enabled: ${botInstance.data.is_enabled}`);
            return;
        }
        
        // Check if this is a temporary bot that has expired
        if (botInstance.data.is_temporary && botInstance.data.expires_at) {
            const now = new Date();
            const expiresAt = new Date(botInstance.data.expires_at);
            if (now >= expiresAt) {
                logger.debug(`🚫 Bot ${botInstance.id} (${botInstance.data.name}) has expired, not scheduling next response`);
                // Mark as disabled and trigger cleanup
                botInstance.data.is_enabled = 0;
                botInstance.connected = false;
                this.cleanupExpiredBots();
                return;
            }
        }

        // Skip scheduling regular responses for MovieBot-enabled bots
        // They should only respond to movie transcriptions
        if (botInstance.data.moviebot_enabled) {
            logger.debug(`🎬 Bot ${botInstance.id} has MovieBot enabled, skipping regular chat responses`);
            return;
        }

        // Same pattern for VisionBot: a bot opted into the vision path drives
        // chat solely on transcription windows (paired with a screenshot).
        // Without this guard the bot double-posts — one from the regular
        // response_interval timer here, plus one from VisionBotService.
        if (botInstance.data.vision_bot_enabled) {
            logger.debug(`🔍 Bot ${botInstance.id} has VisionBot enabled, skipping regular chat responses`);
            return;
        }

        const minInterval = botInstance.data.response_interval_min * 1000;
        const maxInterval = botInstance.data.response_interval_max * 1000;
        const interval = Math.random() * (maxInterval - minInterval) + minInterval;
        logger.debug(`🤖 Bot ${botInstance.id} scheduled to send message in ${Math.round(interval/1000)} seconds`);

        botInstance.responseTimer = setTimeout(async () => {
            logger.debug(`🤖 Bot ${botInstance.id} timer fired, generating message`);
            await this.generateAndSendMessage(botInstance);
            this.scheduleNextResponse(botInstance);
        }, interval);
    }

    async generateAndSendMessage(botInstance) {
        try {
            // Check if bot is still enabled before generating message
            if (!botInstance.data.is_enabled || !botInstance.connected) {
                logger.debug(`🤖 Bot ${botInstance.id} is disabled or disconnected, skipping message generation`);
                return;
            }
            
            // Check if this is a temporary bot that has expired
            if (botInstance.data.is_temporary && botInstance.data.expires_at) {
                const now = new Date();
                const expiresAt = new Date(botInstance.data.expires_at);
                if (now >= expiresAt) {
                    logger.debug(`🚫 Bot ${botInstance.id} (${botInstance.data.name}) has expired, stopping message generation`);
                    // Stop the bot completely
                    botInstance.data.is_enabled = 0;
                    botInstance.connected = false;
                    if (botInstance.responseTimer) {
                        clearTimeout(botInstance.responseTimer);
                        botInstance.responseTimer = null;
                    }
                    // Trigger cleanup
                    this.cleanupExpiredBots();
                    return;
                }
            }
            
            // Skip regular messages for MovieBot-enabled bots
            // They should only respond to movie transcriptions
            if (botInstance.data.moviebot_enabled) {
                logger.debug(`🎬 Bot ${botInstance.id} has MovieBot enabled, should not be sending regular messages`);
                return;
            }
            
            const personality = botInstance.data.personality_traits ? 
                JSON.parse(botInstance.data.personality_traits) : {};
            
            // Add temperature to personality object
            if (botInstance.data.response_creativity_temperature !== undefined && botInstance.data.response_creativity_temperature !== null) {
                personality.temperature = botInstance.data.response_creativity_temperature;
            }
            
            const response = await this.llmService.generateResponse(
                botInstance.data.prompt,
                botInstance.messageHistory,
                personality,
                botInstance.data.llm_model,  // Pass bot-specific model
                botInstance.username  // Pass bot's username
            );

            // Double-check enabled state before sending (in case it changed during LLM generation)
            if (response && response.message && botInstance.socket && botInstance.connected && botInstance.data.is_enabled) {
                botInstance.socket.emit('send-message', {
                    message: response.message
                });

                // Log message to history with exact prompt
                await this.repo.insertChatMessage({
                    chatbotId: botInstance.id,
                    message: response.message,
                    context: JSON.stringify(botInstance.messageHistory.slice(-5)),
                    exactPrompt: response.exactPrompt,
                });

                // Update last message time
                await this.repo.touchSessionLastMessage(botInstance.sessionId);
            } else if (!botInstance.data.is_enabled) {
                logger.debug(`🤖 Bot ${botInstance.id} was disabled during message generation, message not sent`);
            }
        } catch (error) {
            logger.error(`Error generating message for bot ${botInstance.id}:`, error);
        }
    }

    async createTemporaryBot(data) {
        try {
            logger.debug(`🤖 Creating temporary bot: ${data.name}`);
            
            // Calculate expiration time
            const expiresAt = new Date(Date.now() + (data.duration || 3600) * 1000);
            
            // Read the active MovieBot prompt template via the factory-wired
            // closure (PR 1.3). MovieBotService.loadConfigFromDatabase always
            // populates config.moviePromptTemplate to either the DB-stored
            // value (admin-editable) or its built-in `defaultPromptTemplate`,
            // so under normal startup the closure returns a real value.
            // Fallback only fires during the brief window between server
            // start and MovieBot's async config load; the short string is a
            // deliberately minimal stand-in for that race.
            const movieBotPrompt =
                this.getMoviePromptTemplate?.() ||
                `You are watching a stream. Your core identity is that you are currently a viewer of this stream watching the content.`;
            
            const combinedPrompt = `${movieBotPrompt}\n\nYour specific personality: ${data.personalityPrompt}\nYour name is ${data.name}.`;
            
            // Create the bot in database
            const result = await this.repo.createTemporary({
                name: data.name,
                prompt: combinedPrompt,
                summoned_by_user_id: data.summonedBy,
                expires_at: expiresAt.toISOString(),
                summon_item_id: data.itemId || null,
                llm_model: data.llmModel || 'openai',
                response_creativity_temperature: data.temperature || 0.8,
            });

            // Get the created bot
            const bot = await this.repo.getById(result.id);

            // Create entry in temporary_bots table
            await this.repo.createTemporaryRecord({
                chatbotId: bot.id,
                summonedByUserId: data.summonedBy,
                summonedByUsername: data.summonedByUsername || 'User',
                personalityPrompt: data.personalityPrompt,
                expiresAt: expiresAt.toISOString(),
            });
            
            // Start the bot
            await this.startBot(bot);
            
            // Schedule expiration
            this.scheduleExpiration(bot.id, data.duration || 3600);
            
            logger.debug(`✅ Temporary bot ${bot.name} (ID: ${bot.id}) created and started`);
            return bot;
            
        } catch (error) {
            logger.error('❌ Error creating temporary bot:', error);
            throw error;
        }
    }
    
    scheduleExpiration(botId, durationSeconds) {
        const timeoutMs = durationSeconds * 1000;
        
        logger.debug(`⏰ Scheduling expiration for bot ${botId} in ${durationSeconds} seconds`);
        
        setTimeout(async () => {
            try {
                logger.debug(`🗑️ Expiring temporary bot ${botId}`);

                // Stop the bot
                await this.stopBot(botId);

                // Delete from related tables first (order matters due to foreign keys)
                await this.repo.deleteAutoSummonedForBot(botId);
                await this.repo.deleteTemporaryRecord(botId);

                // Delete from chatbots table — only if the row is still
                // marked temporary, in case it was promoted out from under us.
                await this.repo.deleteTemporaryById(botId);

                logger.debug(`✅ Temporary bot ${botId} expired and removed`);
            } catch (error) {
                logger.error(`❌ Error expiring bot ${botId}:`, error);
            }
        }, timeoutMs);
    }
    
    async cleanupExpiredBots() {
        try {
            // Find all expired temporary bots
            const expired = await this.repo.findExpiredTemporary();
            
            if (expired.length === 0) {
                return 0;
            }
            
            logger.debug(`🧹 Cleaning up ${expired.length} expired temporary bots`);
            
            for (const bot of expired) {
                logger.debug(`  - Removing expired bot: ${bot.name} (ID: ${bot.id})`);
                
                // First stop the bot if it's running
                const botInstance = this.bots.get(bot.id);
                if (botInstance) {
                    logger.debug(`    Stopping active bot instance for ${bot.name}`);
                    // Clear any scheduled timers
                    if (botInstance.responseTimer) {
                        clearTimeout(botInstance.responseTimer);
                        botInstance.responseTimer = null;
                    }
                    // Mark as disabled to prevent new messages
                    botInstance.data.is_enabled = 0;
                    botInstance.connected = false;
                }
                
                await this.stopBot(bot.id);

                // Delete from related tables first (order matters due to foreign keys)
                // auto_summoned_bots doesn't have ON DELETE CASCADE, so must delete manually
                await this.repo.deleteAutoSummonedForBot(bot.id);
                await this.repo.deleteTemporaryRecord(bot.id);

                // Then delete from chatbots table (chatbot_sessions and chatbot_message_history cascade)
                await this.repo.deleteById(bot.id);
            }
            
            logger.debug(`✅ Successfully cleaned up ${expired.length} expired temporary bots`);
            return expired.length;
        } catch (error) {
            logger.error('❌ Error cleaning up expired bots:', error);
            return 0;
        }
    }

    async toggleBot(id) {
        try {
            const botId = parseInt(id);
            const bot = await this.repo.getById(botId);

            if (!bot) {
                throw new Error('Bot not found');
            }

            const newState = !bot.is_enabled;

            await this.repo.setEnabled(botId, newState);

            // Update in-memory state
            const botInstance = this.bots.get(botId);
            if (botInstance) {
                botInstance.data.is_enabled = newState ? 1 : 0;
                // Clear any pending response timers if disabling
                if (!newState && botInstance.responseTimer) {
                    clearTimeout(botInstance.responseTimer);
                    botInstance.responseTimer = null;
                }
            }

            if (newState) {
                bot.is_enabled = 1;
                if (!this.bots.has(botId)) {
                    await this.startBot(bot);
                } else {
                    // Restart scheduling for existing bot
                    this.scheduleNextResponse(botInstance);
                }
            } else {
                await this.stopBot(botId);
            }

            return { ...bot, is_enabled: newState };
        } catch (error) {
            logger.error('Error toggling bot:', error);
            throw error;
        }
    }

    async enableAllBots() {
        try {
            // Update all bots to enabled state
            await this.repo.enableAll();

            // Get all bots
            const bots = await this.repo.listForBulk();
            
            // Update in-memory bot instances and start bots
            for (const bot of bots) {
                // Update existing in-memory instances
                const botInstance = this.bots.get(bot.id);
                if (botInstance) {
                    botInstance.data.is_enabled = 1; // Update in-memory state
                }
                
                // Start bots that aren't already running
                if (!this.bots.has(bot.id)) {
                    await this.startBot(bot);
                } else {
                    // Restart scheduling for existing bots
                    this.scheduleNextResponse(botInstance);
                }
            }
            
            logger.debug(`✅ Enabled all ${bots.length} chatbots`);
            return { success: true, count: bots.length };
        } catch (error) {
            logger.error('Error enabling all bots:', error);
            throw error;
        }
    }

    async disableAllBots() {
        try {
            logger.debug('🤖 DISABLE ALL: Starting to disable all bots...');
            logger.debug(`🤖 DISABLE ALL: Current bots Map size: ${this.bots.size}`);
            logger.debug(`🤖 DISABLE ALL: Current bots Map keys: ${Array.from(this.bots.keys())}`);
            
            // Check what's actually in the database
            const dbBots = await this.repo.listSummary();
            logger.debug(`🤖 DISABLE ALL: Found ${dbBots.length} bots in database:`);
            dbBots.forEach(bot => logger.debug(`   - Bot ${bot.id}: ${bot.name} (enabled: ${bot.is_enabled})`));

            // Check active sessions (for logging purposes only)
            const activeSessions = await this.repo.listConnectedSessions();
            logger.debug(`🤖 DISABLE ALL: Found ${activeSessions.length} active sessions with socket connections`);

            // Update all bots to disabled state
            await this.repo.disableAll();
            logger.debug('🤖 DISABLE ALL: Database updated - all bots set to disabled');
            
            // CRITICAL: Stop all in-memory bot instances FIRST (to disconnect their chat service sockets)
            const runningBots = Array.from(this.bots.keys());
            logger.debug(`🤖 DISABLE ALL: Found ${runningBots.length} running bots in memory`);
            
            for (const botId of runningBots) {
                const botInstance = this.bots.get(botId);
                if (botInstance) {
                    logger.debug(`🤖 DISABLE ALL: Stopping bot ${botId}`);
                    
                    // Clear any pending response timers
                    if (botInstance.responseTimer) {
                        clearTimeout(botInstance.responseTimer);
                        botInstance.responseTimer = null;
                    }
                    
                    // CRITICAL: Disconnect the socket connection to chat service
                    if (botInstance.socket && botInstance.socket.connected) {
                        logger.debug(`🤖 DISABLE ALL: Force disconnecting chat service socket for bot ${botId}`);
                        botInstance.socket.disconnect(true); // Force disconnect from chat service
                        botInstance.connected = false;
                    }
                    
                    // Remove from Map
                    this.bots.delete(botId);
                }
            }
            
            // Clean up ALL active sessions from database
            await this.repo.deleteAllSessions();
            logger.debug(`🤖 DISABLE ALL: Cleaned up ${activeSessions.length} active sessions from database`);
            
            // Clear the entire bots Map to ensure clean state
            this.bots.clear();
            logger.debug('🤖 DISABLE ALL: Cleared all bots from memory');
            
            // Return count of database bots + sessions cleaned up
            const totalActionsCount = dbBots.length;
            logger.debug(`✅ DISABLE ALL: Completed - disabled ${dbBots.length} bots and disconnected ${activeSessions.length} socket connections`);
            return { success: true, count: totalActionsCount, botsDisabled: dbBots.length, sessionsDisconnected: activeSessions.length };
        } catch (error) {
            logger.error('Error disabling all bots:', error);
            throw error;
        }
    }

    async testBot(id) {
        try {
            const botId = parseInt(id);
            const bot = await this.repo.getById(botId);

            if (!bot) {
                throw new Error('Bot not found');
            }

            const personality = bot.personality_traits ? 
                JSON.parse(bot.personality_traits) : {};

            // Generate a test response with sample context
            const sampleContext = [
                { username: 'User1', message: 'Hey everyone!' },
                { username: 'User2', message: 'What are we watching today?' },
                { username: 'User3', message: 'This stream is pretty cool' }
            ];

            // Add temperature to personality object
            if (bot.response_creativity_temperature !== undefined && bot.response_creativity_temperature !== null) {
                personality.temperature = bot.response_creativity_temperature;
            }
            
            const response = await this.llmService.generateResponse(
                bot.prompt,
                sampleContext,
                personality,
                bot.llm_model  // Pass bot-specific model
            );

            return {
                bot_name: bot.name,
                response: response.message || response,
                context: sampleContext,
                prompts: {
                    global: response.globalPrompt,
                    individual: response.individualPrompt,
                    full: response.fullPrompt
                }
            };
        } catch (error) {
            logger.error('Error testing bot:', error);
            throw error;
        }
    }

    async sendManualMessage(id, customMessage = null) {
        try {
            const botId = parseInt(id);
            const bot = await this.repo.getById(botId);

            if (!bot) {
                throw new Error('Bot not found');
            }

            // Check if bot is already connected
            let botInstance = this.bots.get(botId);
            
            // If not connected, temporarily connect the bot
            if (!botInstance || !botInstance.connected) {
                logger.debug(`🤖 Temporarily connecting bot ${bot.name} for manual message`);
                
                // Use assigned name if enabled, otherwise generate random name
                // SQLite returns 1/0 for booleans, convert to proper boolean
                const useAssignedName = bot.use_assigned_name === 1 || bot.use_assigned_name === true;
                const username = useAssignedName ? 
                    bot.name : 
                    this.generateUsername(null);
                const color = this.generateColor();
                
                const { io: ioClient } = require('socket.io-client');
                const socket = ioClient(this.chatServiceUrl, {
                    path: '/chat/socket.io',
                    transports: ['websocket'],
                    query: {
                        isBot: true,
                        botId: bot.id
                    }
                });

                return new Promise((resolve, reject) => {
                    socket.on('connect', async () => {
                        logger.debug(`🤖 Bot ${bot.name} connected for manual message`);
                        
                        // Join chat
                        socket.emit('join-chat', {
                            username: bot.show_robot_emoji ? `🤖 ${username}` : username,
                            color: color,
                            isBot: true
                        });

                        // Wait a moment for join to complete
                        setTimeout(async () => {
                            let message = customMessage;
                            
                            // If no custom message, generate one
                            if (!message) {
                                const personality = bot.personality_traits ? 
                                    JSON.parse(bot.personality_traits) : {};
                                
                                // Add temperature to personality object
                                if (bot.response_creativity_temperature !== undefined && bot.response_creativity_temperature !== null) {
                                    personality.temperature = bot.response_creativity_temperature;
                                }
                                
                                // Get recent chat context if available
                                const context = botInstance?.messageHistory || [];
                                
                                const response = await this.llmService.generateResponse(
                                    bot.prompt,
                                    context,
                                    personality,
                                    bot.llm_model  // Pass bot-specific model
                                );
                                
                                logger.debug(`🤖 DEBUG (temp): LLM response type: ${typeof response}, value:`, response);
                                
                                // Handle both old string format and new object format
                                if (typeof response === 'object' && response.message) {
                                    message = response.message;
                                } else if (typeof response === 'string') {
                                    message = response;
                                } else {
                                    logger.error(`🤖 ERROR (temp): Invalid response format:`, response);
                                    message = "I'm having trouble generating a response right now.";
                                }
                                
                                logger.debug(`🤖 DEBUG (temp): Final message: "${message}"`);
                            }

                            // Send the message
                            socket.emit('send-message', { message });
                            
                            logger.debug(`🤖 Manual message sent from ${bot.name}: "${message}"`);
                            
                            // Disconnect after sending
                            setTimeout(() => {
                                socket.disconnect();
                            }, 500);
                            
                            resolve({
                                bot_name: bot.name,
                                message,
                                sent_at: new Date().toISOString()
                            });
                        }, 500);
                    });

                    socket.on('error', (error) => {
                        logger.error(`❌ Error connecting bot for manual message:`, error);
                        reject(error);
                    });
                });
            } else {
                // Bot is already connected, use existing connection
                let message = customMessage;
                
                let promptInfo = null;
                
                if (!message) {
                    const personality = bot.personality_traits ? 
                        JSON.parse(bot.personality_traits) : {};
                    
                    // Add temperature to personality object
                    if (bot.response_creativity_temperature !== undefined && bot.response_creativity_temperature !== null) {
                        personality.temperature = bot.response_creativity_temperature;
                    }
                    
                    const response = await this.llmService.generateResponse(
                        bot.prompt,
                        botInstance.messageHistory,
                        personality,
                        bot.llm_model  // Pass bot-specific model
                    );
                    
                    logger.debug(`🤖 DEBUG: LLM response type: ${typeof response}, value:`, response);
                    
                    // Handle both old string format and new object format
                    if (typeof response === 'object' && response.message) {
                        message = response.message;
                        promptInfo = response;
                    } else if (typeof response === 'string') {
                        message = response;
                        promptInfo = { message: response };
                    } else {
                        logger.error(`🤖 ERROR: Invalid response format:`, response);
                        message = "I'm having trouble generating a response right now.";
                        promptInfo = { message: message };
                    }
                    
                    logger.debug(`🤖 DEBUG: Final message: "${message}"`);
                }

                botInstance.socket.emit('send-message', { message });
                
                // Log to history with exact prompt
                await this.repo.insertChatMessage({
                    chatbotId: botId,
                    message,
                    context: JSON.stringify(botInstance.messageHistory.slice(-5)),
                    exactPrompt: promptInfo?.exactPrompt || null,
                });

                logger.debug(`🤖 Manual message sent from ${bot.name}: "${message}"`);
                
                return {
                    bot_name: bot.name,
                    message,
                    sent_at: new Date().toISOString()
                };
            }
        } catch (error) {
            logger.error('Error sending manual message:', error);
            throw error;
        }
    }

    async getActiveSessions() {
        try {
            return await this.repo.listActiveSessionsWithBot();
        } catch (error) {
            logger.error('Error getting active sessions:', error);
            throw error;
        }
    }

    async getMessageHistory(botId, limit = 50) {
        try {
            return await this.repo.getMessages(parseInt(botId), limit);
        } catch (error) {
            logger.error('Error getting message history:', error);
            throw error;
        }
    }

    // MovieBot integration methods
    getActiveBots() {
        const activeBots = [];
        const now = new Date();
        
        for (const [id, bot] of this.bots) {
            if (bot.connected && bot.data.is_enabled) {
                // Check if temporary bot has expired
                if (bot.data.is_temporary && bot.data.expires_at) {
                    const expiresAt = new Date(bot.data.expires_at);
                    if (now >= expiresAt) {
                        logger.debug(`🚫 Skipping expired bot ${bot.data.id} (${bot.data.name}) from active bots list`);
                        continue;
                    }
                }
                
                activeBots.push({
                    id: bot.data.id,
                    username: bot.username,
                    name: bot.data.name,
                    model: bot.data.llm_model,
                    moviebot_enabled: bot.data.moviebot_enabled === 1 || bot.data.moviebot_enabled === true,
                    vision_bot_enabled: bot.data.vision_bot_enabled === 1 || bot.data.vision_bot_enabled === true
                });
            }
        }
        return activeBots;
    }

    async getMovieBotEnabledBots() {
        try {
            const bots = await this.repo.getMovieBotEnabled();
            
            const activeBots = [];
            const now = new Date();
            
            for (const bot of bots) {
                const botInstance = this.bots.get(bot.id);
                if (botInstance && botInstance.connected) {
                    // Check if temporary bot has expired
                    if (bot.is_temporary && bot.expires_at) {
                        const expiresAt = new Date(bot.expires_at);
                        if (now >= expiresAt) {
                            logger.debug(`🚫 Skipping expired bot ${bot.id} (${bot.name}) from MovieBot list`);
                            continue;
                        }
                    }
                    
                    activeBots.push({
                        id: bot.id,
                        username: botInstance.username,
                        name: bot.name,
                        model: bot.llm_model
                    });
                }
            }
            
            return activeBots;
        } catch (error) {
            logger.error('Error getting MovieBot enabled bots:', error);
            return [];
        }
    }
    
    getGlobalPrompt() {
        // Return the global prompt that's used for all bots
        // This could be configured, but for now use a default
        return this.globalPrompt || "You are a helpful chat participant. Be engaging and conversational.";
    }
    
    async generateMovieComment(bot, moviePrompt, chatHistory) {
        try {
            logger.debug(`🎬 ChatBotService: Generating movie comment for ${bot.username} (ID: ${bot.id})`);
            
            // Find the bot instance
            const botInstance = this.bots.get(bot.id);
            logger.debug(`🎬 ChatBotService: Bot instance found: ${!!botInstance}, connected: ${botInstance?.connected}`);
            logger.debug(`🎬 ChatBotService: Available bot IDs: ${Array.from(this.bots.keys())}`);
            
            if (!botInstance) {
                logger.error(`❌ ChatBotService: Bot ${bot.id} not found in bots map`);
                return { success: false, error: 'Bot not found in active bots' };
            }
            
            if (!botInstance.connected) {
                logger.error(`❌ ChatBotService: Bot ${bot.id} (${bot.username}) not connected to chat service`);
                return { success: false, error: 'Bot not connected to chat service' };
            }
            
            // Check if this is a temporary bot that has expired
            if (botInstance.data.is_temporary && botInstance.data.expires_at) {
                const now = new Date();
                const expiresAt = new Date(botInstance.data.expires_at);
                if (now >= expiresAt) {
                    logger.debug(`🚫 ChatBotService: Bot ${bot.id} (${bot.username}) has expired, cannot send movie comment`);
                    // Trigger cleanup
                    this.cleanupExpiredBots();
                    return { success: false, error: 'Bot has expired' };
                }
            }
            
            // Get bot's personality traits
            const personality = botInstance.data.personality_traits ? 
                JSON.parse(botInstance.data.personality_traits) : {};
            
            // Add temperature to personality object
            if (botInstance.data.response_creativity_temperature !== undefined && botInstance.data.response_creativity_temperature !== null) {
                personality.temperature = botInstance.data.response_creativity_temperature;
            }
            
            // Generate response for movie comment with transcript focus
            // The moviePrompt should contain the transcript for the bot to comment on
            const response = await this.llmService.generateMovieResponse(
                botInstance.data.prompt,  // Use the bot's individual prompt
                moviePrompt,  // The movie transcript/prompt to comment on
                chatHistory || [],
                personality,
                botInstance.data.llm_model,
                botInstance.username  // Pass bot's username for self-awareness
            );
            
            // PR-M4 (ADR-0013): output-moderation gate. Runs Stage 1 + Stage 2
            // on the generated reply before it reaches chat-service. Flagged
            // replies are dropped silently — the bot occasionally "skips a
            // beat" (fine for an entertainment bot) and the admin events
            // tab shows the drop with full context for tuning. Drop semantics
            // chosen per user M0 decision: no retry, no [filtered] placeholder
            // (which would surface moderation noise to chat), no persona
            // disable. If the moderationService isn't wired, this is a no-op
            // and behaviour matches pre-M4.
            if (response && response.message && this.moderationService &&
                typeof this.moderationService.checkBotOutput === 'function') {
                try {
                    // ctx.streamerId is for admin-diagnostics display only.
                    // The streamer's socket id isn't readily available in this
                    // scope (ChatBotService doesn't hold streamService), so
                    // we pass null and the admin UI surfaces just the bot
                    // username + transcript_excerpt for the dropped output.
                    const gate = await this.moderationService.checkBotOutput(response.message, {
                        streamerId: null,
                        botUsername: bot.username,
                    });
                    if (gate && gate.allowed === false) {
                        logger.debug(`🛡️ ChatBotService: MovieBot reply from ${bot.username} dropped by moderation (reason=${gate.reason}, eventId=${gate.eventId})`);
                        return { success: false, error: `moderation_dropped:${gate.reason}`, moderation_event_id: gate.eventId || null };
                    }
                } catch (err) {
                    logger.error('❌ ChatBotService: moderation gate threw:', err.message);
                    // Fail open here — a bug in the moderation gate shouldn't
                    // silence the bot. The next-tier defense (Stage 1+2 on the
                    // STREAMER's audio) still applies, and outright slurs in
                    // the bot reply would have to come from a Groq response
                    // that escaped its own safety filters.
                }
            }

            // Send the message through the bot's socket
            if (response && response.message && botInstance.socket && botInstance.connected) {
                logger.debug(`🎬 ChatBotService: Attempting to send movie comment from ${bot.username}: "${response.message}"`);
                logger.debug(`🎬 ChatBotService: Socket connected: ${botInstance.socket.connected}, Bot connected: ${botInstance.connected}`);
                
                // Add message delivery verification
                let messageDelivered = false;
                const messageId = `movie_${Date.now()}_${bot.id}`;
                
                // Set up a timeout to verify message delivery
                const deliveryTimeout = setTimeout(() => {
                    if (!messageDelivered) {
                        logger.error(`❌ ChatBotService: Message delivery timeout for ${bot.username} - message may not have reached chat`);
                    }
                }, 5000);
                
                // Listen for successful message delivery
                botInstance.socket.once('message-sent', () => {
                    messageDelivered = true;
                    clearTimeout(deliveryTimeout);
                    logger.debug(`✅ ChatBotService: Message delivery confirmed for ${bot.username}`);
                });
                
                // Emit the message
                botInstance.socket.emit('send-message', {
                    message: response.message,
                    messageId: messageId
                });
                
                // Log the movie comment with delivery status
                await this.repo.insertMovieComment({
                    chatbotId: bot.id,
                    message: response.message,
                    metadata: JSON.stringify({
                        is_movie_comment: true,
                        timestamp: new Date().toISOString(),
                        messageId: messageId,
                        chat_service_url: this.chatServiceUrl,
                        socket_id: botInstance.socket.id,
                    }),
                    exactPrompt: moviePrompt,
                });
                
                logger.debug(`✅ ChatBotService: Movie comment sent from ${bot.username} to chat service`);
                
                return {
                    success: true,
                    message: response.message,
                    bot: bot.username,
                    messageId: messageId
                };
            } else {
                // Enhanced error logging
                const errorDetails = [];
                if (!response) errorDetails.push('No response generated');
                if (!response?.message) errorDetails.push('Response has no message');
                if (!botInstance.socket) errorDetails.push('Bot has no socket connection');
                if (!botInstance.connected) errorDetails.push('Bot not marked as connected');
                if (botInstance.socket && !botInstance.socket.connected) errorDetails.push('Socket not connected to chat service');
                
                const errorMsg = `Failed to send message: ${errorDetails.join(', ')}`;
                logger.error(`❌ ChatBotService: ${errorMsg} for bot ${bot.username} (ID: ${bot.id})`);
                logger.error(`❌ ChatBotService: Bot socket state:`, {
                    hasSocket: !!botInstance.socket,
                    socketConnected: botInstance.socket?.connected,
                    botConnected: botInstance.connected,
                    chatServiceUrl: this.chatServiceUrl
                });
                
                return { success: false, error: errorMsg };
            }
            
        } catch (error) {
            logger.error('❌ ChatBotService: Error generating movie comment:', error);
            return { success: false, error: error.message };
        }
    }

    // VisionBot dispatch. Mirrors generateMovieComment but routes through
    // ChatBotLLMService.generateVisionComment (which sends a base64 image
    // to Groq Llama 4 Scout). Adds two guards on top of MovieBot's flow:
    //   1. Stream-takeover check at emit time — if streamGeneration has
    //      bumped since the frame was captured, drop the message; otherwise
    //      streamer A's frame would post into streamer B's chat.
    //   2. exact_prompt persisted to chatbot_message_history is a redacted
    //      summary, NOT the raw chat history + transcription. Raw text
    //      alongside a face image is the PII trifecta we want to avoid.
    async generateVisionCommentForBot({
        bot,
        frame,
        transcription,
        chatHistory,
        abortSignal,
        sourceStreamerId,
        sourceStreamGeneration,
        visionPromptTemplate,
        model,
        maxTokens,
        temperature,
        streamService,
    }) {
        const botInstance = this.bots.get(bot.id);
        if (!botInstance || !botInstance.connected) {
            return { success: false, error: 'Bot not connected' };
        }
        if (botInstance.data && botInstance.data.is_temporary && botInstance.data.expires_at) {
            const now = new Date();
            const expiresAt = new Date(botInstance.data.expires_at);
            if (now >= expiresAt) {
                this.cleanupExpiredBots();
                return { success: false, error: 'Bot has expired' };
            }
        }

        const personality = botInstance.data && botInstance.data.personality_traits
            ? JSON.parse(botInstance.data.personality_traits)
            : {};

        // Vision-template-aware bot prompt: combine the bot's own personality
        // prompt with the VisionBot system template (transcription is
        // interpolated into the user-role text, not the system prompt).
        const botPrompt = (botInstance.data && botInstance.data.prompt) || '';

        let response;
        try {
            response = await this.llmService.generateVisionComment({
                botPrompt: visionPromptTemplate
                    ? `${botPrompt}\n\n${visionPromptTemplate.replace('[TRANSCRIPTION_DATA]', '')}`
                    : botPrompt,
                imageBase64: frame.jpegBase64,
                transcription,
                chatHistory: chatHistory || [],
                personality,
                model,
                username: bot.username,
                maxTokens,
                temperature,
                abortSignal,
            });
        } catch (err) {
            // Re-throw typed errors so VisionBotService can record them in
            // stats / backoff state.
            throw err;
        }

        // Output moderation gate (same as MovieBot).
        if (response && response.message && this.moderationService &&
            typeof this.moderationService.checkBotOutput === 'function') {
            try {
                const gate = await this.moderationService.checkBotOutput(response.message, {
                    streamerId: null,
                    botUsername: bot.username,
                    botType: 'vision',
                    frame_path: frame.sourceSegment,
                });
                if (gate && gate.allowed === false) {
                    const err = new Error(`moderation_dropped:${gate.reason}`);
                    err.droppedReason = 'moderated';
                    throw err;
                }
            } catch (modErr) {
                if (modErr.droppedReason === 'moderated') throw modErr;
                logger.error('❌ ChatBotService: vision moderation gate threw:', modErr.message);
            }
        }

        // F3 takeover guard. Compare the stream generation captured at frame
        // time against the current value at emit time. Mismatch → streamer
        // A's frame is about to land in streamer B's chat. Drop instead.
        if (streamService && typeof streamService.streamGeneration === 'number'
            && typeof sourceStreamGeneration === 'number'
            && streamService.streamGeneration !== sourceStreamGeneration) {
            const err = new Error('streamer_changed');
            err.droppedReason = 'streamer_changed';
            throw err;
        }

        if (!response || !response.message || !botInstance.socket || !botInstance.connected) {
            return { success: false, error: 'no_response_or_socket' };
        }

        const messageId = `vision_${Date.now()}_${bot.id}`;
        botInstance.socket.emit('send-message', {
            message: response.message,
            messageId,
        });

        // Persist with REDACTED exact_prompt — only structural metadata, no
        // raw chat usernames/messages/transcription. The frame is referenced
        // by its segment name (the JPEG itself lives under logs/visionbot/
        // frames/ with its own retention). This is the F5a PII fix.
        const exactPromptRedacted = JSON.stringify({
            type: 'vision_comment',
            systemPromptLength: response.exactPrompt ? response.exactPrompt.systemPromptLength : null,
            userPromptLength: response.exactPrompt ? response.exactPrompt.userPromptLength : null,
            chatHistoryCount: chatHistory ? chatHistory.length : 0,
            transcriptionLength: transcription ? transcription.length : 0,
            model: response.model,
            personalityName: personality && personality.name ? personality.name : null,
        });

        try {
            await this.repo.insertMovieComment({
                chatbotId: bot.id,
                message: response.message,
                metadata: JSON.stringify({
                    is_vision_comment: true,
                    timestamp: new Date().toISOString(),
                    messageId,
                    socket_id: botInstance.socket.id,
                    frame_segment: frame.sourceSegment,
                    frame_size_bytes: frame.sizeBytes,
                    frame_captured_at: frame.capturedAt,
                    source_streamer_id: sourceStreamerId,
                    source_stream_generation: sourceStreamGeneration,
                    model: response.model,
                }),
                exactPrompt: exactPromptRedacted,
            });
        } catch (persistErr) {
            logger.error('❌ ChatBotService: vision comment persistence failed:', persistErr.message);
        }

        return { success: true, message: response.message, bot: bot.username, messageId };
    }

    setGlobalPrompt(prompt) {
        this.globalPrompt = prompt;
        logger.debug('🤖 ChatBotService: Global prompt updated');
    }

    shutdown() {
        logger.debug('Shutting down ChatBot Service...');
        this.bots.forEach((bot, id) => {
            this.stopBot(id);
        });
    }
}

module.exports = ChatBotService;
