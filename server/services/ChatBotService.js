const { io: ioClient } = require('socket.io-client');
const ChatBotLLMService = require('./ChatBotLLMService');
const ChatBotRepository = require('../database/repository/ChatBotRepository');

const logger = require('../bootstrap/logger').child({ svc: 'ChatBotService' });
const { ANIMALS, COLORS } = require('./chatbot/botIdentity');
const { filterActiveMovieBots } = require('./chatbot/movieBotRoster');
const {
    isBotExpired,
    computeResponseInterval,
    buildResponsePersonality,
} = require('./chatbot/responsePolicy');
const TemporaryBotManager = require('./chatbot/TemporaryBotManager');
const BotBulkAdmin = require('./chatbot/BotBulkAdmin');
const BotMessageDispatch = require('./chatbot/BotMessageDispatch');

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
        this.chatServiceUrl = require('../utils/chatServiceClient').chatServiceUrl();
        this.isInitialized = false;
        this.io = null; // Reference to Socket.IO server instance for managing connections
        // BotEventBus is the post-PR-1.3 path for ChatBot → MovieBot signaling.
        // Falls back to null when not injected (the test mocks don't pass one);
        // emit() guards on truthiness so the no-bus case is a silent no-op.
        this.botEventBus = botEventBus;
        // Audit A4 (Plan 07): every connected bot socket receives every chat
        // 'new-message' broadcast, so the per-socket handler used to emit
        // 'chat-message' onto the bus once PER BOT (N duplicates per message,
        // O(N²) event volume into the LLM chat context). Dedup by message
        // identity so the bus sees each chat message exactly once regardless
        // of how many bot sockets observe it. Keyed by the chat-service
        // message id (uuid) with a timestamp+username+message fallback; a
        // small FIFO-bounded set keeps memory constant.
        this.BUS_DEDUP_MAX_KEYS = 500;
        this._busEmittedKeys = new Set();
        this._busEmittedKeyOrder = [];
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

        // Cohesive collaborators. Each gets a back-ref (`owner`) so it reads
        // and mutates the SAME `this.bots` Map and delegates lifecycle calls
        // (startBot/stopBot/scheduleNextResponse/cleanupExpiredBots) back here.
        this.temporaryBotManager = new TemporaryBotManager({ owner: this });
        this.botBulkAdmin = new BotBulkAdmin({ owner: this });
        this.botMessageDispatch = new BotMessageDispatch({ owner: this });

        // Initialization is triggered explicitly during bootstrap
        // (server/index.js awaits chatBotService.initialize()). initialize()
        // early-returns when already initialized, so the bootstrap call is the
        // single canonical trigger — no constructor-side setTimeout fallback.

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

    // Open a socket.io-client connection to the chat service for a bot. Shared
    // by startBot and the manual-message path so the connect options stay in
    // one place. Callers attach their own 'connect'/'join-chat' handlers.
    connectBotSocket(botId) {
        return ioClient(this.chatServiceUrl, {
            path: '/chat/socket.io',
            transports: ['websocket'],
            query: {
                isBot: true,
                botId
            },
            rejectUnauthorized: false // Allow self-signed certificates
        });
    }

    // Audit A4 (Plan 07): emit a chat message onto the BotEventBus exactly
    // once per message, no matter how many bot sockets received the same
    // 'new-message' broadcast. Chat-service messages carry a uuid `id`; the
    // fallback key covers test/legacy payloads without one.
    _emitChatMessageToBus(message) {
        if (!this.botEventBus || !message || !message.username || !message.message) {
            return;
        }
        const key = message.id ||
            `${message.fullTimestamp || message.timestamp || ''}|${message.username}|${message.message}`;
        if (this._busEmittedKeys.has(key)) return;
        this._busEmittedKeys.add(key);
        this._busEmittedKeyOrder.push(key);
        if (this._busEmittedKeyOrder.length > this.BUS_DEDUP_MAX_KEYS) {
            this._busEmittedKeys.delete(this._busEmittedKeyOrder.shift());
        }
        this.botEventBus.emit('chat-message', {
            username: message.username,
            message: message.message,
        });
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
                const additionalInfo = await this.temporaryBotManager.buildTemporaryBotInfo(bot.id);

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
        return this.temporaryBotManager.formatTimeRemaining(seconds);
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
        const socket = this.connectBotSocket(botData.id);

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
            // the factory wires the same bus into both subscribers. Every bot
            // socket receives this broadcast, so the emit is deduped by
            // message identity (audit A4) — the bus sees each chat message
            // exactly once, not once per connected bot.
            this._emitChatMessageToBus(message);
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
        if (isBotExpired(botInstance.data)) {
            logger.debug(`🚫 Bot ${botInstance.id} (${botInstance.data.name}) has expired, not scheduling next response`);
            // Mark as disabled and trigger cleanup
            botInstance.data.is_enabled = 0;
            botInstance.connected = false;
            this.cleanupExpiredBots();
            return;
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

        const interval = computeResponseInterval(botInstance.data);
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
            if (isBotExpired(botInstance.data)) {
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
            
            // Skip regular messages for MovieBot-enabled bots
            // They should only respond to movie transcriptions
            if (botInstance.data.moviebot_enabled) {
                logger.debug(`🎬 Bot ${botInstance.id} has MovieBot enabled, should not be sending regular messages`);
                return;
            }
            
            const personality = buildResponsePersonality(botInstance.data);

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
        return this.temporaryBotManager.createTemporaryBot(data);
    }

    scheduleExpiration(botId, durationSeconds) {
        return this.temporaryBotManager.scheduleExpiration(botId, durationSeconds);
    }

    async cleanupExpiredBots() {
        return this.temporaryBotManager.cleanupExpiredBots();
    }

    async toggleBot(id) {
        return this.botBulkAdmin.toggleBot(id);
    }

    async enableAllBots() {
        return this.botBulkAdmin.enableAllBots();
    }

    async disableAllBots() {
        return this.botBulkAdmin.disableAllBots();
    }

    async testBot(id) {
        return this.botBulkAdmin.testBot(id);
    }

    async sendManualMessage(id, customMessage = null) {
        return this.botBulkAdmin.sendManualMessage(id, customMessage);
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

    async getMovieBotEnabledBots() {
        try {
            const bots = await this.repo.getMovieBotEnabled();
            return filterActiveMovieBots(bots, this.bots, new Date(), logger);
        } catch (error) {
            logger.error('Error getting MovieBot enabled bots:', error);
            return [];
        }
    }
    
    async generateMovieComment(bot, moviePrompt, chatHistory) {
        return this.botMessageDispatch.generateMovieComment(bot, moviePrompt, chatHistory);
    }

    async generateVisionCommentForBot(opts) {
        return this.botMessageDispatch.generateVisionCommentForBot(opts);
    }

    shutdown() {
        logger.debug('Shutting down ChatBot Service...');
        this.bots.forEach((bot, id) => {
            this.stopBot(id);
        });
    }
}

module.exports = ChatBotService;
