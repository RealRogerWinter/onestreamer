const path = require('path');
const TranscriptionDrivenBotService = require('./TranscriptionDrivenBotService');

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

        // Categorization is dormant — processTranscriptionWithBatching dispatches
        // to every enabled MovieBot regardless of category. Fields preserved so
        // any external observer of this.botCategories / this.preferredBotCategories
        // (admin tooling, tests) keeps working.
        this.botCategories = {
            'quick_reactors': [],
            'deep_thinkers': [],
            'creative_minds': [],
        };
        this.preferredBotCategories = {
            'TheComedian': 'quick_reactors',
            'TheInventor': 'quick_reactors',
            'TheScholar': 'deep_thinkers',
            'TheMystic': 'deep_thinkers',
            'TheArtist': 'creative_minds',
            'TheStrategist': 'creative_minds',
        };

        // 100 ms delay to let the database wrapper finish initialization
        // before we issue the first SELECT against moviebot_config.
        setTimeout(() => this.loadConfigFromDatabase(), 100);

        console.log('🎬 MovieBotService: Initialized');
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
        if (row.groq_api_key && this.chatBotService && this.chatBotService.llmService) {
            this.chatBotService.llmService.groqApiKey = row.groq_api_key;
            if (this.config.useGroq) {
                this.chatBotService.llmService.enableGroq(row.groq_api_key);
                console.log('✅ MovieBotService: Groq enabled from database config');
            }
        }
    }

    buildSaveConfigSQL(includeApiKey, apiKey) {
        if (includeApiKey && apiKey) {
            return {
                query: `
                    INSERT OR REPLACE INTO moviebot_config (
                        id, enabled, streamer_id, use_groq, groq_api_key,
                        transcription_duration, transcription_frequency,
                        chat_history_limit, message_delay_min, message_delay_max,
                        movie_prompt_template, updated_at
                    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                `,
                params: [
                    this.config.enabled ? 1 : 0,
                    this.currentStreamerId || null,
                    this.config.useGroq ? 1 : 0,
                    apiKey,
                    this.config.transcriptionDuration,
                    this.config.transcriptionFrequency,
                    this.config.chatHistoryLimit,
                    this.config.messageDelay.min,
                    this.config.messageDelay.max,
                    this.config.moviePromptTemplate || this.defaultPromptTemplate,
                ],
            };
        }
        return {
            query: `
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

    async onTranscriptionComplete(transcription, _sessionData) {
        await this.processTranscriptionWithBatching(transcription, 0);
    }

    // ── MovieBot-specific dispatch & prompting ─────────────────────────

    assignBotsToCategories(availableBots) {
        this.botCategories = {
            'quick_reactors': [],
            'deep_thinkers': [],
            'creative_minds': [],
        };
        const unassignedBots = [];
        for (const bot of availableBots) {
            const preferredCategory = this.preferredBotCategories[bot.name];
            if (preferredCategory) {
                this.botCategories[preferredCategory].push(bot.name);
            } else {
                unassignedBots.push(bot.name);
            }
        }
        const categories = Object.keys(this.botCategories);
        for (const botName of unassignedBots) {
            let minCategory = categories[0];
            let minCount = this.botCategories[minCategory].length;
            for (const category of categories) {
                if (this.botCategories[category].length < minCount) {
                    minCount = this.botCategories[category].length;
                    minCategory = category;
                }
            }
            this.botCategories[minCategory].push(botName);
        }
        return this.botCategories;
    }

    async processTranscription(transcriptionText) {
        const validation = this.validateMeaningfulTranscription(transcriptionText);
        if (!validation) {
            console.log(`⚠️ MovieBotService: Transcription invalid or lacks meaningful content, skipping`);
            return;
        }
        const { cleanText } = validation;
        try {
            const chatHistory = await this.getChatHistory(this.config.chatHistoryLimit);
            const movieBotEnabledBots = await this.chatBotService.getMovieBotEnabledBots();
            if (movieBotEnabledBots.length === 0) {
                console.log('⚠️ MovieBotService: No chatbots with MovieBot enabled');
                return;
            }
            const moviePrompt = this.buildMoviePrompt(cleanText, chatHistory);
            for (const bot of movieBotEnabledBots) {
                try {
                    this.logPrompt(bot.username, moviePrompt, cleanText);
                    const response = await this.chatBotService.generateMovieComment(bot, moviePrompt, chatHistory);
                    if (response && response.success && response.message) {
                        this.logBotResponse(bot.username, cleanText, response.message);
                        this.emit('moviebot-comment', {
                            bot: bot.username,
                            transcription: cleanText,
                            comment: response.message,
                            timestamp: new Date(),
                        });
                    } else {
                        this.logBotError(bot.username, cleanText, response?.error || 'No response generated');
                    }
                } catch (error) {
                    this.logBotError(bot.username, cleanText, error.message);
                }
            }
        } catch (error) {
            console.error('❌ MovieBotService: Error processing transcription:', error);
        }
    }

    async processTranscriptionWithBatching(transcriptionText, cycleIndex) {
        const validation = this.validateMeaningfulTranscription(transcriptionText);
        if (!validation) {
            console.log(`⚠️ MovieBotService: Transcription invalid or lacks meaningful content, skipping`);
            return;
        }
        const { cleanText, meaningfulWords } = validation;
        console.log(`🎬 MovieBotService: Processing transcription ${cycleIndex + 1} with batching (${cleanText.length} chars, ${meaningfulWords.length} meaningful words)`);

        try {
            const chatHistory = await this.getChatHistory(this.config.chatHistoryLimit);
            const allMovieBotEnabledBots = await this.chatBotService.getMovieBotEnabledBots();
            if (allMovieBotEnabledBots.length === 0) {
                console.log('⚠️ MovieBotService: No chatbots with MovieBot enabled');
                return;
            }
            const targetBots = allMovieBotEnabledBots;
            const moviePrompt = this.buildMoviePrompt(cleanText, chatHistory);

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
            console.error('❌ MovieBotService: Error processing transcription with batching:', error);
        }
    }

    buildMoviePrompt(transcriptionText, chatHistory) {
        const globalPrompt = this.chatBotService.getGlobalPrompt();
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
            this.chatBotService.llmService.groqApiKey = newConfig.groqApiKey;
        }
        if (newConfig.useGroq !== undefined) {
            this.config.useGroq = newConfig.useGroq;
            if (this.chatBotService && this.chatBotService.llmService) {
                if (newConfig.useGroq) {
                    const success = this.chatBotService.llmService.enableGroq(newConfig.groqApiKey);
                    if (!success) {
                        console.log('⚠️ MovieBotService: Failed to enable Groq (API key missing?)');
                        this.config.useGroq = false;
                    }
                } else {
                    this.chatBotService.llmService.disableGroq();
                }
            }
        }
        const saveWithApiKey = newConfig.groqApiKey !== undefined;
        this.saveConfigToDatabase(saveWithApiKey, newConfig.groqApiKey);
        this.logEvent('CONFIG_UPDATED', newConfig);
        return { success: true, config: this.config };
    }
}

module.exports = MovieBotService;
