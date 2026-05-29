// Temporary-bot lifecycle, extracted from ChatBotService (behavior-preserving).
// Owns createTemporaryBot / scheduleExpiration / cleanupExpiredBots /
// formatTimeRemaining and the temporary-bot branch of getAllBots' status
// enrichment. Shares the owner's `bots` Map and delegates start/stop back
// through the owner so existing test spies on startBot/stopBot still fire.

const logger = require('../../bootstrap/logger').child({ svc: 'ChatBotService' });
const {
    buildCombinedPrompt,
    temporaryBotExpiresAt,
    deleteTemporaryBotRecords,
    quiesceBotInstance,
} = require('./temporaryBotLifecycle');

class TemporaryBotManager {
    /**
     * @param {object} deps
     * @param {object} deps.owner - the ChatBotService instance (back-ref for
     *   bots Map, repo, getMoviePromptTemplate, startBot, stopBot).
     */
    constructor({ owner }) {
        this.owner = owner;
    }

    get repo() {
        return this.owner.repo;
    }

    async createTemporaryBot(data) {
        try {
            logger.debug(`🤖 Creating temporary bot: ${data.name}`);

            // Calculate expiration time
            const expiresAt = temporaryBotExpiresAt(data.duration || 3600);

            // Read the active MovieBot prompt template via the factory-wired
            // closure (PR 1.3). MovieBotService.loadConfigFromDatabase always
            // populates config.moviePromptTemplate to either the DB-stored
            // value (admin-editable) or its built-in `defaultPromptTemplate`,
            // so under normal startup the closure returns a real value.
            // Fallback only fires during the brief window between server
            // start and MovieBot's async config load; the short string is a
            // deliberately minimal stand-in for that race.
            const movieBotPrompt =
                this.owner.getMoviePromptTemplate?.() ||
                `You are watching a stream. Your core identity is that you are currently a viewer of this stream watching the content.`;

            const combinedPrompt = buildCombinedPrompt(movieBotPrompt, data.personalityPrompt, data.name);

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
            await this.owner.startBot(bot);

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
                await this.owner.stopBot(botId);

                // Delete records (FK-safe order). The final delete only removes
                // the chatbot row if it's still temporary, in case it was
                // promoted out from under us.
                await deleteTemporaryBotRecords(this.repo, botId, 'deleteTemporaryById');

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
                const botInstance = this.owner.bots.get(bot.id);
                if (botInstance) {
                    logger.debug(`    Stopping active bot instance for ${bot.name}`);
                    quiesceBotInstance(botInstance);
                }

                await this.owner.stopBot(bot.id);

                // Delete records (FK-safe order; auto_summoned_bots has no
                // ON DELETE CASCADE, so it is removed explicitly first).
                await deleteTemporaryBotRecords(this.repo, bot.id, 'deleteById');
            }

            logger.debug(`✅ Successfully cleaned up ${expired.length} expired temporary bots`);
            return expired.length;
        } catch (error) {
            logger.error('❌ Error cleaning up expired bots:', error);
            return 0;
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

    // Temporary-bot branch of getAllBots: builds the extra status fields for a
    // bot that has a temporary_bots row. Returns {} for non-temporary bots.
    async buildTemporaryBotInfo(botId) {
        const tempBotInfo = await this.repo.getTemporaryBotInfo(botId);
        if (!tempBotInfo) {
            return {};
        }

        const now = Date.now();
        const expiresAt = new Date(tempBotInfo.expires_at).getTime();
        const timeRemaining = Math.max(0, Math.floor((expiresAt - now) / 1000));

        return {
            is_temporary: true,
            summoned_by: tempBotInfo.summoned_by_username,
            summoned_by_user_id: tempBotInfo.summoned_by_user_id,
            personality_prompt: tempBotInfo.personality_prompt,
            expires_at: tempBotInfo.expires_at,
            time_remaining_seconds: timeRemaining,
            time_remaining_display: this.formatTimeRemaining(timeRemaining),
        };
    }
}

module.exports = TemporaryBotManager;
