const path = require('path');
const TranscriptionDrivenBotService = require('./TranscriptionDrivenBotService');

const logger = require('../bootstrap/logger').child({ svc: 'MovieBotService' });
class MovieBotService extends TranscriptionDrivenBotService {
    constructor(transcriptionService, chatBotService, chatService, database, botEventBus = null) {
        super({
            botName: 'MovieBotService',
            eventPrefix: 'moviebot',
            configTableName: 'moviebot_config',
            logDir: path.join(__dirname, '..', '..', 'logs', 'moviebot'),
            transcriptionService,
            chatBotService,
            chatService,
            database,
            botEventBus,
        });

        this.defaultPromptTemplate = `You are watching a stream. Your core identity is that you are currently a viewer of this stream watching the content. You will actively comment on what's happening in the stream. Read through the chatlogs above to pick out details about what people think about the stream content. Respond to those comments or respond to what is actively happening in the stream. The most important information you need is the last 45-seconds of audio from the stream. Incorporate a direct response to this transcription, or incorporate the context of it within your next message. Here is the transcription:

[TRANSCRIPTION_DATA]`;

        // 100 ms delay to let the database wrapper finish initialization
        // before we issue the first SELECT against moviebot_config.
        setTimeout(() => this.loadConfigFromDatabase(), 100);

        logger.debug('🎬 MovieBotService: Initialized');
    }

    // ── Base-class hook implementations ────────────────────────────────

    getDefaultConfig() {
        return {
            enabled: false,
            transcriptionDuration: 45,
            transcriptionFrequency: 120,
            chatHistoryLimit: 30,
            useGroq: false,
            messageDelay: { min: 4000, max: 8000 },
            moviePromptTemplate: this.defaultPromptTemplate,
        };
    }

    parseConfigRow(row) {
        return {
            enabled: row.enabled === 1,
            streamerId: row.streamer_id || null,
            transcriptionDuration: row.transcription_duration || 45,
            transcriptionFrequency: row.transcription_frequency || 120,
            chatHistoryLimit: row.chat_history_limit || 30,
            useGroq: row.use_groq === 1,
            messageDelay: {
                min: row.message_delay_min || 4000,
                max: row.message_delay_max || 8000,
            },
            moviePromptTemplate: row.movie_prompt_template || this.defaultPromptTemplate,
        };
    }

    afterConfigLoaded(row) {
        const llm = this.chatBotService && this.chatBotService.llmService;
        if (!llm) return;

        // A7 (audit Plan 07): `groq_config.api_key` is the single source of
        // truth for the Groq key. MovieBot used to keep its own copy in
        // `moviebot_config.groq_api_key` and clobber the LLM service's key
        // with it on every load, so the two tables silently diverged. The
        // legacy column is no longer read except here — a one-time migration
        // into groq_config for old installs whose key ONLY lives in
        // moviebot_config.
        if (row.groq_api_key) {
            this._migrateLegacyGroqKey(row.groq_api_key, llm);
        }
    }

    /**
     * One-time migration of a legacy `moviebot_config.groq_api_key` into the
     * canonical `groq_config` row. Checks the groq_config TABLE directly (not
     * the in-memory llm state, whose own async load may not have finished)
     * so a key already stored in groq_config is never clobbered.
     */
    _migrateLegacyGroqKey(legacyKey, llm) {
        const finish = () => {
            if (this.config.useGroq) {
                // No explicit key: enableGroq() uses the groq_config-sourced
                // key already on the LLM service (or the one just migrated).
                if (llm.enableGroq()) {
                    logger.debug('✅ MovieBotService: Groq enabled from database config');
                } else {
                    logger.warn('⚠️ MovieBotService: useGroq is set but no Groq API key is available');
                }
            }
        };
        if (!this.db) {
            finish();
            return;
        }
        this.db.get(`SELECT api_key FROM groq_config WHERE id = 1`, (err, groqRow) => {
            if (err) {
                logger.error('❌ MovieBotService: Could not read groq_config for legacy-key migration:', err);
                finish();
                return;
            }
            if (groqRow && groqRow.api_key) {
                // groq_config already has a key — it wins; the legacy copy in
                // moviebot_config is ignored (left in place, never re-read).
                logger.debug('📝 MovieBotService: groq_config already has an API key; ignoring legacy moviebot_config.groq_api_key');
            } else {
                llm.groqApiKey = legacyKey;
                llm.saveGroqConfig();
                logger.info('🔑 MovieBotService: Migrated legacy moviebot_config.groq_api_key into groq_config (single source of truth)');
            }
            finish();
        });
    }

    // A7 (audit Plan 07): moviebot_config.groq_api_key is a legacy column —
    // never written anymore (Groq key writes go to groq_config via the LLM
    // service). The upsert creates the singleton row when missing (the job
    // the old `INSERT OR REPLACE ... groq_api_key` branch used to do) while
    // leaving the legacy column untouched on existing rows.
    buildSaveConfigSQL(_includeApiKey, _apiKey) {
        return {
            query: `
                INSERT INTO moviebot_config (
                    id, enabled, streamer_id, use_groq,
                    transcription_duration, transcription_frequency,
                    chat_history_limit, message_delay_min, message_delay_max,
                    movie_prompt_template, updated_at
                ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                    enabled = excluded.enabled,
                    streamer_id = excluded.streamer_id,
                    use_groq = excluded.use_groq,
                    transcription_duration = excluded.transcription_duration,
                    transcription_frequency = excluded.transcription_frequency,
                    chat_history_limit = excluded.chat_history_limit,
                    message_delay_min = excluded.message_delay_min,
                    message_delay_max = excluded.message_delay_max,
                    movie_prompt_template = excluded.movie_prompt_template,
                    updated_at = excluded.updated_at
            `,
            params: [
                this.config.enabled ? 1 : 0,
                this.currentStreamerId || null,
                this.config.useGroq ? 1 : 0,
                this.config.transcriptionDuration,
                this.config.transcriptionFrequency,
                this.config.chatHistoryLimit,
                this.config.messageDelay.min,
                this.config.messageDelay.max,
                this.config.moviePromptTemplate || this.defaultPromptTemplate,
            ],
        };
    }

    async onTranscriptionComplete(transcription, sessionData) {
        // Rebroadcast on BotEventBus so siblings (VisionBot) can ride this
        // window. Done before the dispatch so VisionBot starts its frame
        // capture in parallel with MovieBot's chat dispatch.
        if (this.botEventBus && sessionData) {
            this.botEventBus.emit('moviebot-transcription-complete', {
                streamerId: this.currentStreamerId,
                sessionId: sessionData.sessionId,
                transcription,
                endTime: sessionData.endTime,
                wordCount: sessionData.wordCount,
            });
        }
        await this.processTranscriptionWithBatching(transcription, 0);
    }

    // ── MovieBot-specific dispatch & prompting ─────────────────────────

    async processTranscriptionWithBatching(transcriptionText, cycleIndex) {
        const validation = this.validateMeaningfulTranscription(transcriptionText);
        if (!validation) {
            logger.debug(`⚠️ MovieBotService: Transcription invalid or lacks meaningful content, skipping`);
            return;
        }
        const { cleanText, meaningfulWords } = validation;
        logger.debug(`🎬 MovieBotService: Processing transcription ${cycleIndex + 1} with batching (${cleanText.length} chars, ${meaningfulWords.length} meaningful words)`);

        try {
            const chatHistory = await this.getChatHistory(this.config.chatHistoryLimit);
            const allMovieBotEnabledBots = await this.chatBotService.getMovieBotEnabledBots();
            if (allMovieBotEnabledBots.length === 0) {
                logger.debug('⚠️ MovieBotService: No chatbots with MovieBot enabled');
                return;
            }
            const targetBots = allMovieBotEnabledBots;
            const moviePrompt = await this.buildMoviePrompt(cleanText, chatHistory);

            // Stagger responses so the chat doesn't get a thundering herd of bot
            // messages — each subsequent bot waits messageDelay.min..max ms more
            // than the previous one.
            let cumulativeDelay = 0;
            for (let i = 0; i < targetBots.length; i++) {
                const bot = targetBots[i];
                if (i > 0) {
                    const delayRange = this.config.messageDelay.max - this.config.messageDelay.min;
                    const randomDelay = Math.floor(Math.random() * delayRange) + this.config.messageDelay.min;
                    cumulativeDelay += randomDelay;
                }
                const botDelay = cumulativeDelay;
                setTimeout(async () => {
                    try {
                        const response = await this.chatBotService.generateMovieComment(bot, moviePrompt, chatHistory);
                        if (response && response.success && response.message) {
                            this.logBotResponse(bot.username, cleanText, response.message);
                            this.emit('moviebot-comment', {
                                bot: bot.username,
                                transcription: cleanText,
                                comment: response.message,
                                timestamp: new Date(),
                                cycleIndex,
                            });
                        } else {
                            this.logBotError(bot.username, cleanText, response?.error || 'No response generated');
                        }
                    } catch (error) {
                        this.logBotError(bot.username, cleanText, error.message);
                    }
                }, botDelay);
            }
        } catch (error) {
            logger.error('❌ MovieBotService: Error processing transcription with batching:', error);
        }
    }

    async buildMoviePrompt(transcriptionText, chatHistory) {
        // Single source of truth: the DB-backed global prompt owned by
        // ChatBotLLMService. This is the same admin-configured prompt chat bots
        // use (and falls back to DEFAULT_GLOBAL_PROMPT when the DB value is
        // empty), so MovieBot and chat stay aligned.
        const globalPrompt = await this.chatBotService.llmService.getGlobalPrompt();
        let chatContext = '';
        if (chatHistory && chatHistory.length > 0) {
            chatContext = '\n\nRecent chat messages:\n';
            chatHistory.forEach(msg => {
                chatContext += `${msg.username}: ${msg.message}\n`;
            });
        } else {
            chatContext = '\n\nRecent chat messages:\n(No recent messages available)\n';
        }
        const moviePrompt = this.config.moviePromptTemplate.replace('[TRANSCRIPTION_DATA]', transcriptionText);
        return `${globalPrompt}${chatContext}\n\n${moviePrompt}`;
    }

    // ── Status / config update ─────────────────────────────────────────

    getStatus() {
        if (!this.config) {
            this.loadConfigFromDatabase();
        }
        return {
            enabled: this.config?.enabled || false,
            isActive: this.isActive || false,
            currentStreamerId: this.currentStreamerId || null,
            currentSession: this.currentSession || null,
            config: this.config || this.getDefaultConfig(),
            recentPrompts: this.promptHistory?.slice(-10) || [],
        };
    }

    updateConfig(newConfig) {
        if (!this.config) {
            this.loadConfigFromDatabase();
            if (!this.config) this.config = this.getDefaultConfig();
        }
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
            // A7 (audit Plan 07): persist the admin-supplied key into
            // groq_config (single source of truth), NOT moviebot_config.
            this.chatBotService.llmService.groqApiKey = newConfig.groqApiKey || null;
            this.chatBotService.llmService.saveGroqConfig();
        }
        if (newConfig.useGroq !== undefined) {
            this.config.useGroq = newConfig.useGroq;
            if (this.chatBotService && this.chatBotService.llmService) {
                if (newConfig.useGroq) {
                    const success = this.chatBotService.llmService.enableGroq(newConfig.groqApiKey);
                    if (!success) {
                        logger.debug('⚠️ MovieBotService: Failed to enable Groq (API key missing?)');
                        this.config.useGroq = false;
                    }
                } else {
                    this.chatBotService.llmService.disableGroq();
                }
            }
        }
        // A7: never write the key into moviebot_config (legacy column); the
        // groq_config write above already persisted it.
        this.saveConfigToDatabase();
        this.logEvent('CONFIG_UPDATED', {
            ...newConfig,
            // Don't write the raw API key into the moviebot event log.
            ...(newConfig.groqApiKey !== undefined ? { groqApiKey: '[REDACTED]' } : {}),
        });
        return { success: true, config: this.config };
    }
}

module.exports = MovieBotService;
