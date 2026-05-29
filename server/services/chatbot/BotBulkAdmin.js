// Bulk + per-bot admin operations, extracted from ChatBotService
// (behavior-preserving). Owns enableAllBots / disableAllBots / toggleBot /
// testBot / sendManualMessage. Shares the owner's `bots` Map and delegates
// start/stop/scheduling back through the owner so existing test spies still
// fire. De-dups applied while moving:
//   (a) personality + temperature build -> buildResponsePersonality
//   (b) LLM-response normalization -> _normalizeLlmMessage
//   (c) socket-create + join-chat handshake -> owner.connectBotSocket (the
//       same path used by startBot; the redundant inline socket.io-client
//       require is removed).

const logger = require('../../bootstrap/logger').child({ svc: 'ChatBotService' });
const { buildResponsePersonality } = require('./responsePolicy');

class BotBulkAdmin {
    /**
     * @param {object} deps
     * @param {object} deps.owner - the ChatBotService instance (back-ref for
     *   bots Map, repo, llmService, start/stop/scheduling, socket connect).
     */
    constructor({ owner }) {
        this.owner = owner;
    }

    get repo() {
        return this.owner.repo;
    }

    get llmService() {
        return this.owner.llmService;
    }

    // Normalize a ChatBotLLMService response that may be the new object form
    // ({ message, ... }) or the legacy string form. Returns the text or the
    // shared error fallback. `tag` only annotates the debug/error logs so the
    // temporary-connection and existing-connection paths stay distinguishable.
    _normalizeLlmMessage(response, tag = '') {
        const suffix = tag ? ` ${tag}` : '';
        logger.debug(`🤖 DEBUG${suffix}: LLM response type: ${typeof response}, value:`, response);

        let message;
        if (typeof response === 'object' && response.message) {
            message = response.message;
        } else if (typeof response === 'string') {
            message = response;
        } else {
            logger.error(`🤖 ERROR${suffix}: Invalid response format:`, response);
            message = "I'm having trouble generating a response right now.";
        }

        logger.debug(`🤖 DEBUG${suffix}: Final message: "${message}"`);
        return message;
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
            const botInstance = this.owner.bots.get(botId);
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
                if (!this.owner.bots.has(botId)) {
                    await this.owner.startBot(bot);
                } else {
                    // Restart scheduling for existing bot
                    this.owner.scheduleNextResponse(botInstance);
                }
            } else {
                await this.owner.stopBot(botId);
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
                const botInstance = this.owner.bots.get(bot.id);
                if (botInstance) {
                    botInstance.data.is_enabled = 1; // Update in-memory state
                }

                // Start bots that aren't already running
                if (!this.owner.bots.has(bot.id)) {
                    await this.owner.startBot(bot);
                } else {
                    // Restart scheduling for existing bots
                    this.owner.scheduleNextResponse(botInstance);
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
            logger.debug(`🤖 DISABLE ALL: Current bots Map size: ${this.owner.bots.size}`);
            logger.debug(`🤖 DISABLE ALL: Current bots Map keys: ${Array.from(this.owner.bots.keys())}`);

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
            const runningBots = Array.from(this.owner.bots.keys());
            logger.debug(`🤖 DISABLE ALL: Found ${runningBots.length} running bots in memory`);

            for (const botId of runningBots) {
                const botInstance = this.owner.bots.get(botId);
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
                    this.owner.bots.delete(botId);
                }
            }

            // Clean up ALL active sessions from database
            await this.repo.deleteAllSessions();
            logger.debug(`🤖 DISABLE ALL: Cleaned up ${activeSessions.length} active sessions from database`);

            // Clear the entire bots Map to ensure clean state
            this.owner.bots.clear();
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

            const personality = buildResponsePersonality(bot);

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
            let botInstance = this.owner.bots.get(botId);

            // If not connected, temporarily connect the bot
            if (!botInstance || !botInstance.connected) {
                logger.debug(`🤖 Temporarily connecting bot ${bot.name} for manual message`);

                // Use assigned name if enabled, otherwise generate random name
                // SQLite returns 1/0 for booleans, convert to proper boolean
                const useAssignedName = bot.use_assigned_name === 1 || bot.use_assigned_name === true;
                const username = useAssignedName ?
                    bot.name :
                    this.owner.generateUsername(null);
                const color = this.owner.generateColor();

                const socket = this.owner.connectBotSocket(bot.id);

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
                                const personality = buildResponsePersonality(bot);

                                // Get recent chat context if available
                                const context = botInstance?.messageHistory || [];

                                const response = await this.llmService.generateResponse(
                                    bot.prompt,
                                    context,
                                    personality,
                                    bot.llm_model  // Pass bot-specific model
                                );

                                message = this._normalizeLlmMessage(response, '(temp)');
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
                    const personality = buildResponsePersonality(bot);

                    const response = await this.llmService.generateResponse(
                        bot.prompt,
                        botInstance.messageHistory,
                        personality,
                        bot.llm_model  // Pass bot-specific model
                    );

                    message = this._normalizeLlmMessage(response);

                    // Preserve prompt metadata only when the LLM returned the
                    // object form; otherwise fall back to wrapping the message.
                    if (typeof response === 'object' && response.message) {
                        promptInfo = response;
                    } else {
                        promptInfo = { message };
                    }
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
}

module.exports = BotBulkAdmin;
