/**
 * AutoSummonManager.js - StreamBot auto-summon system extracted from
 * StreamBotService.
 *
 * Owns the auto-summon scheduler (interval + catch-up timeout), the summon
 * orchestration (generate a contrasting pair, spawn two temporary bots via
 * owner.chatBotService, log + announce), and the auto_summon_settings /
 * auto_summoned_bots persistence. All timer/counter state stays on the service
 * (owner.autoSummonIntervalId / owner.autoSummonTimeoutId). Bodies moved
 * verbatim (only `this.`→`owner.`); cross-calls route through `owner.<method>`.
 */

const logger = require('../../bootstrap/logger').child({ svc: 'StreamBotService' });

class AutoSummonManager {
    constructor(owner) {
        this.owner = owner;
    }

    async startAutoSummon() {
        const owner = this.owner;
        // Clear any existing interval and timeout
        if (owner.autoSummonIntervalId) {
            clearInterval(owner.autoSummonIntervalId);
            owner.autoSummonIntervalId = null;
        }
        if (owner.autoSummonTimeoutId) {
            clearTimeout(owner.autoSummonTimeoutId);
            owner.autoSummonTimeoutId = null;
        }

        // Get auto-summon settings
        const settings = await owner.getAutoSummonSettings();

        if (!settings || !settings.enabled) {
            logger.debug('🤖 StreamBot: Auto-summon is disabled');
            return;
        }

        const intervalMs = settings.interval_minutes * 60 * 1000;
        logger.debug(`🤖 StreamBot: Starting auto-summon system (interval: ${settings.interval_minutes} minutes)`);

        // Check if we should summon immediately (based on last summon time)
        const lastSummoned = settings.last_summoned_at ? new Date(settings.last_summoned_at) : null;
        const now = new Date();
        const msSinceLastSummon = lastSummoned ? (now - lastSummoned) : Infinity;

        // Helper to start the regular interval
        const startRegularInterval = () => {
            owner.autoSummonIntervalId = setInterval(async () => {
                await owner.autoSummonBot();
            }, intervalMs);
        };

        if (msSinceLastSummon >= intervalMs) {
            // Summon immediately and start regular interval
            await owner.autoSummonBot();
            startRegularInterval();
        } else {
            // Calculate remaining time until next summon
            const remainingMs = intervalMs - msSinceLastSummon;
            const remainingMinutes = Math.round(remainingMs / 1000 / 60);
            logger.debug(`🤖 StreamBot: Next auto-summon in ${remainingMinutes} minutes`);

            // Set a timeout for the remaining time, then start regular interval
            owner.autoSummonTimeoutId = setTimeout(async () => {
                await owner.autoSummonBot();
                startRegularInterval();
            }, remainingMs);
        }
    }

    async stopAutoSummon() {
        const owner = this.owner;
        if (owner.autoSummonTimeoutId) {
            clearTimeout(owner.autoSummonTimeoutId);
            owner.autoSummonTimeoutId = null;
        }
        if (owner.autoSummonIntervalId) {
            clearInterval(owner.autoSummonIntervalId);
            owner.autoSummonIntervalId = null;
        }
        logger.debug('🤖 StreamBot: Auto-summon stopped');
    }

    async autoSummonBot() {
        const owner = this.owner;
        try {
            const settings = await owner.getAutoSummonSettings();
            if (!settings || !settings.enabled) {
                logger.debug('🤖 StreamBot: Auto-summon disabled, skipping');
                return;
            }

            // Check if services are available
            if (!owner.chatBotService) {
                logger.error('❌ StreamBot: ChatBotService not available for auto-summon');
                return;
            }

            logger.debug('🎭 StreamBot: Generating character pair via Groq...');

            // Generate a pair of opposing characters using Groq
            const pair = await owner.generateCharacterPair();
            if (!pair || !pair.positive || !pair.negative) {
                logger.error('❌ StreamBot: Failed to generate character pair');
                return;
            }

            logger.debug(`🎭 StreamBot: Generated pair - ${pair.positive.name} (positive) & ${pair.negative.name} (negative)`);

            // Create the positive bot
            const positiveBot = await owner.chatBotService.createTemporaryBot({
                name: pair.positive.name,
                personalityPrompt: pair.positive.personality,
                summonedBy: 0,
                summonedByUsername: 'StreamBot',
                duration: settings.bot_duration_seconds,
                itemId: null,
                llmModel: 'groq',
                temperature: 0.9
            });

            // Create the negative bot
            const negativeBot = await owner.chatBotService.createTemporaryBot({
                name: pair.negative.name,
                personalityPrompt: pair.negative.personality,
                summonedBy: 0,
                summonedByUsername: 'StreamBot',
                duration: settings.bot_duration_seconds,
                itemId: null,
                llmModel: 'groq',
                temperature: 0.9
            });

            // Log both auto-summoned bots in history
            await owner.logAutoSummonedBot(positiveBot.id, pair.positive.name, pair.positive.personality, pair.positive.generatedPrompt);
            await owner.logAutoSummonedBot(negativeBot.id, pair.negative.name, pair.negative.personality, pair.negative.generatedPrompt);

            // Update last summoned time and counter (count as 2)
            await owner.updateAutoSummonSettings({
                last_summoned_at: new Date().toISOString(),
                total_summoned: (settings.total_summoned || 0) + 2
            });

            // Send announcement to chat
            const announcement = `👥 Two new viewers just joined! Welcome ${pair.positive.name} and ${pair.negative.name} to the chat!`;
            await owner.sendToChatService(announcement);

            logger.debug(`✅ StreamBot: Auto-summoned pair ${pair.positive.name} & ${pair.negative.name} successfully!`);

        } catch (error) {
            logger.error('❌ StreamBot: Error in auto-summon:', error);
        }
    }

    async getAutoSummonSettings() {
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.get(
                'SELECT * FROM auto_summon_settings WHERE id = 1',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async updateAutoSummonSettings(updates) {
        const owner = this.owner;
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }

        if (fields.length === 0) return;

        fields.push('updated_at = CURRENT_TIMESTAMP');

        return new Promise((resolve, reject) => {
            owner.db.run(
                `UPDATE auto_summon_settings SET ${fields.join(', ')} WHERE id = 1`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async toggleAutoSummon() {
        const owner = this.owner;
        const settings = await owner.getAutoSummonSettings();
        const newEnabled = settings.enabled ? 0 : 1;

        await owner.updateAutoSummonSettings({ enabled: newEnabled });

        if (newEnabled) {
            await owner.startAutoSummon();
        } else {
            await owner.stopAutoSummon();
        }

        return newEnabled;
    }

    async logAutoSummonedBot(chatbotId, botName, personality, generatedPrompt) {
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.run(
                `INSERT INTO auto_summoned_bots (chatbot_id, bot_name, personality_prompt, generated_prompt)
                 VALUES (?, ?, ?, ?)`,
                [chatbotId, botName, personality, generatedPrompt],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID });
                }
            );
        });
    }

    async getAutoSummonedBotHistory(limit = 20) {
        const owner = this.owner;
        return new Promise((resolve, reject) => {
            owner.db.all(
                `SELECT * FROM auto_summoned_bots ORDER BY summoned_at DESC LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async triggerManualAutoSummon() {
        const owner = this.owner;
        // Force an immediate auto-summon (for testing/manual trigger)
        logger.debug('🎭 StreamBot: Manual auto-summon triggered');
        return await owner.autoSummonBot();
    }
}

module.exports = AutoSummonManager;
