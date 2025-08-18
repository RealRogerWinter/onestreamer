const { io: ioClient } = require('socket.io-client');
const database = require('../database/database');
const ChatBotLLMService = require('./ChatBotLLMService');

class ChatBotService {
    constructor() {
        this.bots = new Map(); // botId -> BotInstance
        this.llmService = new ChatBotLLMService();
        this.chatServiceUrl = process.env.CHAT_SERVICE_URL || 'http://localhost:8081';
        this.isInitialized = false;
        this.io = null; // Reference to Socket.IO server instance for managing connections
        this.movieBotService = null; // Reference to MovieBotService for chat history
        
        // Animal names for random usernames (matching chat service)
        this.ANIMALS = [
            'Lion', 'Tiger', 'Bear', 'Wolf', 'Fox', 'Rabbit', 'Deer', 'Eagle', 'Hawk', 'Owl',
            'Cat', 'Dog', 'Mouse', 'Rat', 'Hamster', 'Squirrel', 'Beaver', 'Otter', 'Seal', 'Whale',
            'Shark', 'Fish', 'Crab', 'Lobster', 'Shrimp', 'Octopus', 'Jellyfish', 'Starfish', 'Turtle', 'Snake',
            'Lizard', 'Frog', 'Toad', 'Salamander', 'Newt', 'Butterfly', 'Bee', 'Ant', 'Spider', 'Scorpion',
            'Penguin', 'Flamingo', 'Swan', 'Duck', 'Goose', 'Chicken', 'Turkey', 'Peacock', 'Parrot', 'Canary'
        ];
        
        // Color palette for usernames
        this.COLORS = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8E8', '#F7DC6F',
            '#BB8FCE', '#85C1E9', '#F8C471', '#82E0AA', '#F1948A', '#AED6F1', '#A9DFBF', '#F9E79F',
            '#D7BDE2', '#A3E4D7', '#FAD7A0', '#D5A6BD', '#87CEEB', '#DEB887', '#F0E68C', '#FFB6C1'
        ];
    }

    async initialize() {
        if (this.isInitialized) return;
        
        try {
            console.log('🤖 INIT: Starting ChatBot Service initialization...');
            
            // Load and start all enabled bots
            const bots = await database.allAsync(
                'SELECT * FROM chatbots WHERE is_enabled = 1'
            );
            
            console.log(`🤖 INIT: Found ${bots.length} enabled bots in database`);
            bots.forEach(bot => console.log(`   - Bot ${bot.id}: ${bot.name}`));
            
            for (const bot of bots) {
                console.log(`🤖 INIT: Starting bot ${bot.id} (${bot.name})`);
                await this.startBot(bot);
                console.log(`🤖 INIT: Bot ${bot.id} started, bots Map size is now: ${this.bots.size}`);
            }
            
            this.isInitialized = true;
            console.log(`✅ ChatBot Service initialized with ${bots.length} bots`);
            console.log(`🤖 INIT: Final bots Map size: ${this.bots.size}`);
            console.log(`🤖 INIT: Final bots Map keys: ${Array.from(this.bots.keys())}`);
        } catch (error) {
            console.error('❌ ChatBot Service initialization error:', error);
        }
    }

    setIoInstance(io) {
        this.io = io;
        console.log('🤖 ChatBot Service: Socket.IO instance set for managing connections');
    }
    
    setMovieBotService(movieBotService) {
        this.movieBotService = movieBotService;
        console.log('🤖 ChatBot Service: MovieBotService reference set for chat history');
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
            const result = await database.runAsync(
                `INSERT INTO chatbots (name, prompt, is_enabled, response_interval_min, 
                 response_interval_max, show_robot_emoji, personality_traits, use_assigned_name, llm_model, moviebot_enabled)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    data.name || this.generateUsername(),
                    data.prompt || 'You are a friendly chat participant.',
                    data.is_enabled !== undefined ? data.is_enabled : 1,
                    data.response_interval_min || 60,
                    data.response_interval_max || 180,
                    data.show_robot_emoji !== undefined ? data.show_robot_emoji : 1,
                    JSON.stringify(data.personality_traits || {}),
                    data.use_assigned_name !== undefined ? data.use_assigned_name : 1,
                    data.llm_model || null,  // null means use global default
                    data.moviebot_enabled !== undefined ? data.moviebot_enabled : 0
                ]
            );
            
            const bot = await database.getAsync(
                'SELECT * FROM chatbots WHERE id = ?',
                [result.id]
            );
            
            if (bot.is_enabled) {
                await this.startBot(bot);
            }
            
            return bot;
        } catch (error) {
            console.error('Error creating bot:', error);
            throw error;
        }
    }

    async updateBot(id, data) {
        try {
            // Convert id to number for consistency with the Map keys
            const botId = parseInt(id);
            
            const updates = [];
            const params = [];
            
            if (data.name !== undefined) {
                updates.push('name = ?');
                params.push(data.name);
            }
            if (data.prompt !== undefined) {
                updates.push('prompt = ?');
                params.push(data.prompt);
            }
            if (data.is_enabled !== undefined) {
                updates.push('is_enabled = ?');
                params.push(data.is_enabled);
            }
            if (data.response_interval_min !== undefined) {
                updates.push('response_interval_min = ?');
                params.push(data.response_interval_min);
            }
            if (data.response_interval_max !== undefined) {
                updates.push('response_interval_max = ?');
                params.push(data.response_interval_max);
            }
            if (data.show_robot_emoji !== undefined) {
                updates.push('show_robot_emoji = ?');
                params.push(data.show_robot_emoji);
            }
            if (data.personality_traits !== undefined) {
                updates.push('personality_traits = ?');
                params.push(JSON.stringify(data.personality_traits));
            }
            if (data.use_assigned_name !== undefined) {
                updates.push('use_assigned_name = ?');
                params.push(data.use_assigned_name);
            }
            if (data.llm_model !== undefined) {
                updates.push('llm_model = ?');
                params.push(data.llm_model || null);
            }
            if (data.moviebot_enabled !== undefined) {
                updates.push('moviebot_enabled = ?');
                params.push(data.moviebot_enabled);
            }
            
            updates.push('updated_at = CURRENT_TIMESTAMP');
            params.push(botId);
            
            await database.runAsync(
                `UPDATE chatbots SET ${updates.join(', ')} WHERE id = ?`,
                params
            );
            
            const bot = await database.getAsync(
                'SELECT * FROM chatbots WHERE id = ?',
                [botId]
            );
            
            // Restart bot if it's running (use numeric id for Map lookup)
            if (this.bots.has(botId)) {
                await this.stopBot(botId);
            }
            
            if (bot.is_enabled) {
                await this.startBot(bot);
            }
            
            return bot;
        } catch (error) {
            console.error('Error updating bot:', error);
            throw error;
        }
    }

    async deleteBot(id) {
        try {
            const botId = parseInt(id);
            await this.stopBot(botId);
            await database.runAsync('DELETE FROM chatbots WHERE id = ?', [botId]);
            return { success: true };
        } catch (error) {
            console.error('Error deleting bot:', error);
            throw error;
        }
    }

    async getAllBots() {
        try {
            const bots = await database.allAsync('SELECT * FROM chatbots ORDER BY created_at DESC');
            
            // Add runtime status and last message for each bot
            const botsWithStatus = await Promise.all(bots.map(async (bot) => {
                // Get the last message from history
                const lastMessage = await database.getAsync(
                    `SELECT message, created_at FROM chatbot_message_history 
                     WHERE chatbot_id = ? 
                     ORDER BY created_at DESC 
                     LIMIT 1`,
                    [bot.id]
                );
                
                return {
                    ...bot,
                    is_connected: this.bots.has(bot.id) && this.bots.get(bot.id).connected,
                    personality_traits: bot.personality_traits ? JSON.parse(bot.personality_traits) : {},
                    moviebot_enabled: bot.moviebot_enabled === 1 || bot.moviebot_enabled === true,
                    last_message: lastMessage ? lastMessage.message : null,
                    last_message_at: lastMessage ? lastMessage.created_at : null
                };
            }));
            
            return botsWithStatus;
        } catch (error) {
            console.error('Error getting bots:', error);
            throw error;
        }
    }

    async startBot(botData) {
        console.log(`🤖 START: Attempting to start bot ${botData.id} (${botData.name})`);
        console.log(`🤖 START: Current bots Map has bot ${botData.id}: ${this.bots.has(botData.id)}`);
        
        if (this.bots.has(botData.id)) {
            console.log(`🤖 START: Bot ${botData.id} already running, skipping`);
            return;
        }

        // Use assigned name if enabled, otherwise generate random name
        // SQLite returns 1/0 for booleans, convert to proper boolean
        const useAssignedName = botData.use_assigned_name === 1 || botData.use_assigned_name === true;
        const username = useAssignedName ? 
            botData.name : 
            this.generateUsername(null);
        const color = this.generateColor();
        
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
        console.log(`🤖 Attempting to connect bot ${botData.name} to ${this.chatServiceUrl}`);
        const socket = ioClient(this.chatServiceUrl, {
            transports: ['websocket'],
            query: {
                isBot: true,
                botId: botData.id
            }
        });

        socket.on('connect', async () => {
            console.log(`🤖 Bot ${botData.name} connected as ${username} to chat service`);
            botInstance.connected = true;
            botInstance.socket = socket;
            
            // Store session in database
            const session = await database.runAsync(
                `INSERT INTO chatbot_sessions (chatbot_id, socket_id, username, color)
                 VALUES (?, ?, ?, ?)`,
                [botData.id, socket.id, username, color]
            );
            botInstance.sessionId = session.id;
            
            // Join chat with bot metadata
            socket.emit('join-chat', {
                username: botData.show_robot_emoji ? `🤖 ${username}` : username,
                color: color,
                isBot: true
            });
            
            // Start response cycle
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
            
            // Also feed to MovieBotService for context
            if (this.movieBotService && message.username && message.message) {
                this.movieBotService.addChatMessage(message.username, message.message);
            }
        });

        socket.on('connect_error', (error) => {
            console.error(`❌ Bot ${botData.name} connection error:`, error.message);
            console.error(`   Chat service URL: ${this.chatServiceUrl}`);
            console.error(`   Make sure chat service is running on port 8081`);
        });

        socket.on('disconnect', () => {
            console.log(`🤖 Bot ${botData.name} disconnected`);
            botInstance.connected = false;
            
            if (botInstance.responseTimer) {
                clearTimeout(botInstance.responseTimer);
            }
            
            // Mark session as disconnected
            if (botInstance.sessionId) {
                database.runAsync(
                    'UPDATE chatbot_sessions SET socket_id = NULL WHERE id = ?',
                    [botInstance.sessionId]
                );
            }
        });

        botInstance.socket = socket;
        this.bots.set(botData.id, botInstance);
        console.log(`🤖 START: Bot ${botData.id} added to bots Map. New size: ${this.bots.size}`);
    }

    async stopBot(id) {
        const bot = this.bots.get(id);
        if (!bot) return;

        if (bot.responseTimer) {
            clearTimeout(bot.responseTimer);
        }

        if (bot.socket) {
            bot.socket.disconnect();
        }

        // Clean up session
        await database.runAsync(
            'DELETE FROM chatbot_sessions WHERE chatbot_id = ?',
            [id]
        );

        this.bots.delete(id);
        console.log(`🤖 Bot ${id} stopped`);
    }

    scheduleNextResponse(botInstance) {
        if (!botInstance.connected || !botInstance.data.is_enabled) {
            return;
        }

        // If moviebot mode is enabled, disable normal messaging intervals
        if (botInstance.data.moviebot_enabled === 1 || botInstance.data.moviebot_enabled === true) {
            console.log(`🎬 Bot ${botInstance.id} has moviebot mode enabled - disabling normal messaging intervals`);
            return;
        }

        const minInterval = botInstance.data.response_interval_min * 1000;
        const maxInterval = botInstance.data.response_interval_max * 1000;
        const interval = Math.random() * (maxInterval - minInterval) + minInterval;

        botInstance.responseTimer = setTimeout(async () => {
            await this.generateAndSendMessage(botInstance);
            this.scheduleNextResponse(botInstance);
        }, interval);
    }

    async generateAndSendMessage(botInstance) {
        try {
            // Check if bot is still enabled before generating message
            if (!botInstance.data.is_enabled || !botInstance.connected) {
                console.log(`🤖 Bot ${botInstance.id} is disabled or disconnected, skipping message generation`);
                return;
            }
            
            // If moviebot mode is enabled, skip normal message generation (only respond to moviebot prompts)
            if (botInstance.data.moviebot_enabled === 1 || botInstance.data.moviebot_enabled === true) {
                console.log(`🎬 Bot ${botInstance.id} has moviebot mode enabled - skipping normal message generation`);
                return;
            }
            
            const personality = botInstance.data.personality_traits ? 
                JSON.parse(botInstance.data.personality_traits) : {};
            
            const response = await this.llmService.generateResponse(
                botInstance.data.prompt,
                botInstance.messageHistory,
                personality,
                botInstance.data.llm_model  // Pass bot-specific model
            );

            // Double-check enabled state before sending (in case it changed during LLM generation)
            if (response && response.message && botInstance.socket && botInstance.connected && botInstance.data.is_enabled) {
                botInstance.socket.emit('send-message', {
                    message: response.message
                });

                // Log message to history with exact prompt
                await database.runAsync(
                    `INSERT INTO chatbot_message_history (chatbot_id, message, context, exact_prompt)
                     VALUES (?, ?, ?, ?)`,
                    [
                        botInstance.id,
                        response.message,
                        JSON.stringify(botInstance.messageHistory.slice(-5)),
                        response.exactPrompt
                    ]
                );

                // Update last message time
                await database.runAsync(
                    'UPDATE chatbot_sessions SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?',
                    [botInstance.sessionId]
                );
            } else if (!botInstance.data.is_enabled) {
                console.log(`🤖 Bot ${botInstance.id} was disabled during message generation, message not sent`);
            }
        } catch (error) {
            console.error(`Error generating message for bot ${botInstance.id}:`, error);
        }
    }

    async toggleBot(id) {
        try {
            const botId = parseInt(id);
            const bot = await database.getAsync(
                'SELECT * FROM chatbots WHERE id = ?',
                [botId]
            );
            
            if (!bot) {
                throw new Error('Bot not found');
            }

            const newState = !bot.is_enabled;
            
            await database.runAsync(
                'UPDATE chatbots SET is_enabled = ? WHERE id = ?',
                [newState ? 1 : 0, botId]
            );

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
            console.error('Error toggling bot:', error);
            throw error;
        }
    }

    async enableAllBots() {
        try {
            // Update all bots to enabled state
            await database.runAsync('UPDATE chatbots SET is_enabled = 1');
            
            // Get all bots
            const bots = await database.allAsync('SELECT * FROM chatbots');
            
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
            
            console.log(`✅ Enabled all ${bots.length} chatbots`);
            return { success: true, count: bots.length };
        } catch (error) {
            console.error('Error enabling all bots:', error);
            throw error;
        }
    }

    async disableAllBots() {
        try {
            console.log('🤖 DISABLE ALL: Starting to disable all bots...');
            console.log(`🤖 DISABLE ALL: Current bots Map size: ${this.bots.size}`);
            console.log(`🤖 DISABLE ALL: Current bots Map keys: ${Array.from(this.bots.keys())}`);
            
            // Check what's actually in the database
            const dbBots = await database.allAsync('SELECT id, name, is_enabled FROM chatbots');
            console.log(`🤖 DISABLE ALL: Found ${dbBots.length} bots in database:`);
            dbBots.forEach(bot => console.log(`   - Bot ${bot.id}: ${bot.name} (enabled: ${bot.is_enabled})`));
            
            // Check active sessions (for logging purposes only)
            const activeSessions = await database.allAsync('SELECT * FROM chatbot_sessions WHERE socket_id IS NOT NULL');
            console.log(`🤖 DISABLE ALL: Found ${activeSessions.length} active sessions with socket connections`);
            
            // Update all bots to disabled state
            await database.runAsync('UPDATE chatbots SET is_enabled = 0');
            console.log('🤖 DISABLE ALL: Database updated - all bots set to disabled');
            
            // CRITICAL: Stop all in-memory bot instances FIRST (to disconnect their chat service sockets)
            const runningBots = Array.from(this.bots.keys());
            console.log(`🤖 DISABLE ALL: Found ${runningBots.length} running bots in memory`);
            
            for (const botId of runningBots) {
                const botInstance = this.bots.get(botId);
                if (botInstance) {
                    console.log(`🤖 DISABLE ALL: Stopping bot ${botId}`);
                    
                    // Clear any pending response timers
                    if (botInstance.responseTimer) {
                        clearTimeout(botInstance.responseTimer);
                        botInstance.responseTimer = null;
                    }
                    
                    // CRITICAL: Disconnect the socket connection to chat service
                    if (botInstance.socket && botInstance.socket.connected) {
                        console.log(`🤖 DISABLE ALL: Force disconnecting chat service socket for bot ${botId}`);
                        botInstance.socket.disconnect(true); // Force disconnect from chat service
                        botInstance.connected = false;
                    }
                    
                    // Remove from Map
                    this.bots.delete(botId);
                }
            }
            
            // Clean up ALL active sessions from database
            const deleteResult = await database.runAsync('DELETE FROM chatbot_sessions');
            console.log(`🤖 DISABLE ALL: Cleaned up ${activeSessions.length} active sessions from database`);
            
            // Clear the entire bots Map to ensure clean state
            this.bots.clear();
            console.log('🤖 DISABLE ALL: Cleared all bots from memory');
            
            // Return count of database bots + sessions cleaned up
            const totalActionsCount = dbBots.length;
            console.log(`✅ DISABLE ALL: Completed - disabled ${dbBots.length} bots and disconnected ${activeSessions.length} socket connections`);
            return { success: true, count: totalActionsCount, botsDisabled: dbBots.length, sessionsDisconnected: activeSessions.length };
        } catch (error) {
            console.error('Error disabling all bots:', error);
            throw error;
        }
    }

    async testBot(id) {
        try {
            const botId = parseInt(id);
            const bot = await database.getAsync(
                'SELECT * FROM chatbots WHERE id = ?',
                [botId]
            );
            
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
            console.error('Error testing bot:', error);
            throw error;
        }
    }

    async sendManualMessage(id, customMessage = null) {
        try {
            const botId = parseInt(id);
            const bot = await database.getAsync(
                'SELECT * FROM chatbots WHERE id = ?',
                [botId]
            );
            
            if (!bot) {
                throw new Error('Bot not found');
            }

            // Check if bot is already connected
            let botInstance = this.bots.get(botId);
            
            // If not connected, temporarily connect the bot
            if (!botInstance || !botInstance.connected) {
                console.log(`🤖 Temporarily connecting bot ${bot.name} for manual message`);
                
                // Use assigned name if enabled, otherwise generate random name
                // SQLite returns 1/0 for booleans, convert to proper boolean
                const useAssignedName = bot.use_assigned_name === 1 || bot.use_assigned_name === true;
                const username = useAssignedName ? 
                    bot.name : 
                    this.generateUsername(null);
                const color = this.generateColor();
                
                const { io: ioClient } = require('socket.io-client');
                const socket = ioClient(this.chatServiceUrl, {
                    transports: ['websocket'],
                    query: {
                        isBot: true,
                        botId: bot.id
                    }
                });

                return new Promise((resolve, reject) => {
                    socket.on('connect', async () => {
                        console.log(`🤖 Bot ${bot.name} connected for manual message`);
                        
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
                                
                                // Get recent chat context if available
                                const context = botInstance?.messageHistory || [];
                                
                                const response = await this.llmService.generateResponse(
                                    bot.prompt,
                                    context,
                                    personality,
                                    bot.llm_model  // Pass bot-specific model
                                );
                                
                                console.log(`🤖 DEBUG (temp): LLM response type: ${typeof response}, value:`, response);
                                
                                // Handle both old string format and new object format
                                if (typeof response === 'object' && response.message) {
                                    message = response.message;
                                } else if (typeof response === 'string') {
                                    message = response;
                                } else {
                                    console.error(`🤖 ERROR (temp): Invalid response format:`, response);
                                    message = "I'm having trouble generating a response right now.";
                                }
                                
                                console.log(`🤖 DEBUG (temp): Final message: "${message}"`);
                            }

                            // Send the message
                            socket.emit('send-message', { message });
                            
                            console.log(`🤖 Manual message sent from ${bot.name}: "${message}"`);
                            
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
                        console.error(`❌ Error connecting bot for manual message:`, error);
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
                    
                    const response = await this.llmService.generateResponse(
                        bot.prompt,
                        botInstance.messageHistory,
                        personality,
                        bot.llm_model  // Pass bot-specific model
                    );
                    
                    console.log(`🤖 DEBUG: LLM response type: ${typeof response}, value:`, response);
                    
                    // Handle both old string format and new object format
                    if (typeof response === 'object' && response.message) {
                        message = response.message;
                        promptInfo = response;
                    } else if (typeof response === 'string') {
                        message = response;
                        promptInfo = { message: response };
                    } else {
                        console.error(`🤖 ERROR: Invalid response format:`, response);
                        message = "I'm having trouble generating a response right now.";
                        promptInfo = { message: message };
                    }
                    
                    console.log(`🤖 DEBUG: Final message: "${message}"`);
                }

                botInstance.socket.emit('send-message', { message });
                
                // Log to history with exact prompt
                await database.runAsync(
                    `INSERT INTO chatbot_message_history (chatbot_id, message, context, exact_prompt)
                     VALUES (?, ?, ?, ?)`,
                    [
                        botId,
                        message,
                        JSON.stringify(botInstance.messageHistory.slice(-5)),
                        promptInfo?.exactPrompt || null
                    ]
                );

                console.log(`🤖 Manual message sent from ${bot.name}: "${message}"`);
                
                return {
                    bot_name: bot.name,
                    message,
                    sent_at: new Date().toISOString()
                };
            }
        } catch (error) {
            console.error('Error sending manual message:', error);
            throw error;
        }
    }

    async getActiveSessions() {
        try {
            const sessions = await database.allAsync(
                `SELECT s.*, b.name as bot_name, b.show_robot_emoji
                 FROM chatbot_sessions s
                 JOIN chatbots b ON s.chatbot_id = b.id
                 WHERE s.socket_id IS NOT NULL
                 ORDER BY s.connected_at DESC`
            );
            return sessions;
        } catch (error) {
            console.error('Error getting active sessions:', error);
            throw error;
        }
    }

    async getMessageHistory(botId, limit = 50) {
        try {
            const id = parseInt(botId);
            const messages = await database.allAsync(
                `SELECT * FROM chatbot_message_history
                 WHERE chatbot_id = ?
                 ORDER BY created_at DESC
                 LIMIT ?`,
                [id, limit]
            );
            return messages;
        } catch (error) {
            console.error('Error getting message history:', error);
            throw error;
        }
    }

    // MovieBot integration methods
    getActiveBots() {
        const activeBots = [];
        for (const [id, bot] of this.bots) {
            if (bot.connected && bot.data.is_enabled) {
                activeBots.push({
                    id: bot.data.id,
                    username: bot.username,
                    name: bot.data.name,
                    model: bot.data.llm_model,
                    moviebot_enabled: bot.data.moviebot_enabled === 1 || bot.data.moviebot_enabled === true
                });
            }
        }
        return activeBots;
    }
    
    async getMovieBotEnabledBots() {
        try {
            const bots = await database.allAsync(
                'SELECT * FROM chatbots WHERE is_enabled = 1 AND moviebot_enabled = 1'
            );
            
            const activeBots = [];
            for (const bot of bots) {
                const botInstance = this.bots.get(bot.id);
                if (botInstance && botInstance.connected) {
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
            console.error('Error getting MovieBot enabled bots:', error);
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
            console.log(`🎬 ChatBotService: Generating movie comment for ${bot.username} (ID: ${bot.id})`);
            
            // Find the bot instance
            const botInstance = this.bots.get(bot.id);
            console.log(`🎬 ChatBotService: Bot instance found: ${!!botInstance}, connected: ${botInstance?.connected}`);
            console.log(`🎬 ChatBotService: Available bot IDs: ${Array.from(this.bots.keys())}`);
            
            if (!botInstance) {
                console.error(`❌ ChatBotService: Bot ${bot.id} not found in bots map`);
                return { success: false, error: 'Bot not found in active bots' };
            }
            
            if (!botInstance.connected) {
                console.error(`❌ ChatBotService: Bot ${bot.id} (${bot.username}) not connected to chat service`);
                return { success: false, error: 'Bot not connected to chat service' };
            }
            
            // Get bot's personality traits
            const personality = botInstance.data.personality_traits ? 
                JSON.parse(botInstance.data.personality_traits) : {};
            
            // Generate response for movie comment with transcript focus
            // The moviePrompt should contain the transcript for the bot to comment on
            const response = await this.llmService.generateMovieResponse(
                botInstance.data.prompt,  // Use the bot's individual prompt (though it gets ignored anyway)
                moviePrompt,  // The movie transcript/prompt to comment on
                chatHistory || [],
                personality,
                botInstance.data.llm_model
            );
            
            // Send the message through the bot's socket
            if (response && response.message && botInstance.socket && botInstance.connected) {
                console.log(`🎬 ChatBotService: Attempting to send movie comment from ${bot.username}: "${response.message}"`);
                console.log(`🎬 ChatBotService: Socket connected: ${botInstance.socket.connected}, Bot connected: ${botInstance.connected}`);
                
                // Add message delivery verification
                let messageDelivered = false;
                const messageId = `movie_${Date.now()}_${bot.id}`;
                
                // Set up a timeout to verify message delivery
                const deliveryTimeout = setTimeout(() => {
                    if (!messageDelivered) {
                        console.error(`❌ ChatBotService: Message delivery timeout for ${bot.username} - message may not have reached chat`);
                    }
                }, 5000);
                
                // Listen for successful message delivery
                botInstance.socket.once('message-sent', () => {
                    messageDelivered = true;
                    clearTimeout(deliveryTimeout);
                    console.log(`✅ ChatBotService: Message delivery confirmed for ${bot.username}`);
                });
                
                // Emit the message
                botInstance.socket.emit('send-message', {
                    message: response.message,
                    messageId: messageId
                });
                
                // Log the movie comment with delivery status
                await database.runAsync(
                    `INSERT INTO chatbot_message_history 
                     (chatbot_id, message, message_type, metadata, exact_prompt) 
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        bot.id,
                        response.message,
                        'movie_comment',
                        JSON.stringify({ 
                            is_movie_comment: true,
                            timestamp: new Date().toISOString(),
                            messageId: messageId,
                            chat_service_url: this.chatServiceUrl,
                            socket_id: botInstance.socket.id
                        }),
                        moviePrompt
                    ]
                );
                
                console.log(`✅ ChatBotService: Movie comment sent from ${bot.username} to chat service`);
                
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
                console.error(`❌ ChatBotService: ${errorMsg} for bot ${bot.username} (ID: ${bot.id})`);
                console.error(`❌ ChatBotService: Bot socket state:`, {
                    hasSocket: !!botInstance.socket,
                    socketConnected: botInstance.socket?.connected,
                    botConnected: botInstance.connected,
                    chatServiceUrl: this.chatServiceUrl
                });
                
                return { success: false, error: errorMsg };
            }
            
        } catch (error) {
            console.error('❌ ChatBotService: Error generating movie comment:', error);
            return { success: false, error: error.message };
        }
    }
    
    setGlobalPrompt(prompt) {
        this.globalPrompt = prompt;
        console.log('🤖 ChatBotService: Global prompt updated');
    }

    shutdown() {
        console.log('Shutting down ChatBot Service...');
        this.bots.forEach((bot, id) => {
            this.stopBot(id);
        });
    }
}

module.exports = ChatBotService;