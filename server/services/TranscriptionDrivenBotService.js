const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const logger = require('../bootstrap/logger').child({ svc: 'TranscriptionDrivenBotService' });
// Whisper hallucinates conversational filler ("you you you", "the the and")
// on silent or near-silent audio. We drop transcriptions whose content
// reduces to those tokens before they reach the LLM.
const STOPWORDS = new Set([
    'you', 'the', 'and', 'but', 'for', 'are', 'with', 'his', 'they', 'this',
    'have', 'from', 'one', 'had', 'word', 'not', 'what', 'all', 'were', 'can',
    'said', 'there', 'each', 'which', 'she', 'their', 'time', 'will', 'way',
    'about', 'out', 'many', 'then', 'them', 'these', 'some', 'her', 'would',
    'make', 'like', 'into', 'him', 'has', 'two', 'more', 'very', 'after',
    'first', 'well', 'how', 'now', 'been', 'may', 'come', 'its',
]);

/**
 * Shared base for transcription-driven bots (MovieBot, VisionBot, …).
 *
 * Owns the parts that don't vary between bots:
 *   - config persistence (singleton row in a config table)
 *   - the transcription scheduler + `transcription-stopped` handoff
 *   - chat history accumulation from BotEventBus + DB fallback
 *   - file logging (events, prompts, responses, errors) under `logDir`
 *   - lifecycle plumbing for enable/disable/stop
 *
 * Subclasses provide the bot-specific bits via these hooks:
 *   - `getDefaultConfig()`            → shape of the in-memory config object
 *   - `parseConfigRow(row)`           → DB row → config
 *   - `buildSaveConfigSQL(...)`       → config → DB write
 *   - `onTranscriptionComplete(text, sessionData)` → dispatch step
 *   - `afterConfigLoaded(row)`        → optional post-load side effects
 */
class TranscriptionDrivenBotService extends EventEmitter {
    constructor({
        botName,
        eventPrefix,
        configTableName,
        logDir,
        transcriptionService,
        chatBotService,
        chatService,
        database,
        botEventBus = null,
    }) {
        super();
        this.botName = botName;
        this.eventPrefix = eventPrefix;
        this.configTableName = configTableName;
        this.logDir = logDir;
        this.transcriptionService = transcriptionService;
        this.chatBotService = chatBotService;
        this.chatService = chatService;
        this.database = database;
        this.db = database ? database.db : null;
        this.botEventBus = botEventBus;

        this.recentChatMessages = [];
        this.MAX_CHAT_HISTORY = 50;

        this.config = null;
        this.isActive = false;
        this.currentSessions = [];
        this.transcriptionTimer = null;
        this.currentStreamerId = null;
        this.promptHistory = [];
        this.currentCycleIndex = 0;

        this.ensureLogDirectory();
        this.setupChatListener();
    }

    // ── Subclass hooks (override) ──────────────────────────────────────

    getDefaultConfig() {
        throw new Error(`${this.constructor.name}: must implement getDefaultConfig()`);
    }

    parseConfigRow(_row) {
        throw new Error(`${this.constructor.name}: must implement parseConfigRow(row)`);
    }

    buildSaveConfigSQL(_includeApiKey, _apiKey) {
        throw new Error(`${this.constructor.name}: must implement buildSaveConfigSQL()`);
    }

    async onTranscriptionComplete(_transcriptionText, _sessionData) {
        throw new Error(`${this.constructor.name}: must implement onTranscriptionComplete()`);
    }

    afterConfigLoaded(_row) { /* default no-op */ }

    // ── Lifecycle ──────────────────────────────────────────────────────

    async enable(streamerId) {
        if (this.isActive) {
            return { success: false, error: `${this.botName} is already active` };
        }
        this.isActive = true;
        this.currentStreamerId = streamerId;
        this.config.enabled = true;
        this.saveConfigToDatabase();
        this.scheduleNextTranscription();
        this.emit(`${this.eventPrefix}-enabled`, { streamerId, timestamp: new Date() });
        this.logEvent('ENABLED', { streamerId, config: this.config });
        logger.debug(`🎬 ${this.botName}: Enabled for streamer ${streamerId}`);
        return { success: true, message: `${this.botName} enabled successfully` };
    }

    async disable() {
        if (!this.isActive) {
            return { success: false, error: `${this.botName} is not active` };
        }
        this.isActive = false;
        this.config.enabled = false;
        this.saveConfigToDatabase();
        if (this.transcriptionTimer) {
            clearTimeout(this.transcriptionTimer);
            this.transcriptionTimer = null;
        }
        if ((this.currentSessions && this.currentSessions.length > 0) || this.currentSession) {
            await this.stopCurrentTranscription();
        }
        this.emit(`${this.eventPrefix}-disabled`, { timestamp: new Date() });
        this.logEvent('DISABLED', {});
        this.currentStreamerId = null;
        logger.debug(`🎬 ${this.botName}: Disabled`);
        return { success: true, message: `${this.botName} disabled successfully` };
    }

    // ── Config persistence ─────────────────────────────────────────────

    loadConfigFromDatabase() {
        if (!this.db) {
            logger.debug(`⚠️ ${this.botName}: Database not ready, using defaults`);
            this.config = this.getDefaultConfig();
            return;
        }
        this.db.get(`SELECT * FROM ${this.configTableName} WHERE id = 1`, (err, row) => {
            if (err) {
                logger.error(`❌ ${this.botName}: Error loading config from database:`, err);
                return;
            }
            if (row) {
                this.config = this.parseConfigRow(row);
                this.afterConfigLoaded(row);
                if (this.config.enabled && this.config.streamerId) {
                    logger.debug(`🔄 ${this.botName}: Restoring active state for streamer ${this.config.streamerId}`);
                    this.isActive = true;
                    this.currentStreamerId = this.config.streamerId;
                    this.scheduleNextTranscription();
                }
            } else {
                logger.debug(`📝 ${this.botName}: No saved config found, creating defaults`);
                this.config = this.getDefaultConfig();
                this.saveConfigToDatabase();
            }
        });
    }

    saveConfigToDatabase(includeApiKey = false, apiKey = null) {
        if (!this.db) {
            logger.debug(`⚠️ ${this.botName}: Database not ready, cannot save config`);
            return;
        }
        const { query, params } = this.buildSaveConfigSQL(includeApiKey, apiKey);
        this.db.run(query, params, (err) => {
            if (err) {
                logger.error(`❌ ${this.botName}: Error saving config to database:`, err);
            }
        });
    }

    // ── Transcription orchestration ────────────────────────────────────

    scheduleNextTranscription() {
        if (!this.isActive) return;
        const delay = this.config.transcriptionFrequency * 1000;
        this.transcriptionTimer = setTimeout(() => {
            this.captureAndProcessTranscription();
        }, delay);
    }

    async captureAndProcessTranscription() {
        if (!this.isActive || !this.currentStreamerId) return;
        try {
            const result = await this.transcriptionService.startTimedTranscription(
                this.currentStreamerId,
                this.config.transcriptionDuration,
                { model: 'base', language: 'en' }
            );
            if (!result.success) {
                logger.error(`❌ ${this.botName}: Failed to start transcription:`, result.error);
                this.scheduleNextTranscription();
                return;
            }
            const sessionId = result.sessionId;
            this.currentSessions.push(sessionId);
            this.transcriptionService.once('transcription-stopped', async (data) => {
                if (data.sessionId !== sessionId) return;
                const sessionIndex = this.currentSessions.indexOf(sessionId);
                if (sessionIndex > -1) this.currentSessions.splice(sessionIndex, 1);
                let transcription = data.transcription;
                if (!transcription) {
                    transcription = await this.getTranscriptionText(data.sessionId);
                }
                if (transcription) {
                    try {
                        await this.onTranscriptionComplete(transcription, data);
                    } catch (handlerError) {
                        logger.error(`❌ ${this.botName}: onTranscriptionComplete failed:`, handlerError);
                    }
                }
                this.scheduleNextTranscription();
            });
        } catch (error) {
            logger.error(`❌ ${this.botName}: Error capturing transcription:`, error);
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
            logger.error(`❌ ${this.botName}: Failed to get transcription text:`, error);
            return null;
        }
    }

    async stopCurrentTranscription() {
        if (this.currentSessions && this.currentSessions.length > 0) {
            for (const sessionId of this.currentSessions) {
                try {
                    await this.transcriptionService.stopTranscription(sessionId);
                } catch (error) {
                    logger.error(`❌ ${this.botName}: Error stopping session ${sessionId}:`, error);
                }
            }
            this.currentSessions = [];
        }
        // Pre-multi-session compatibility: older code paths set a singular currentSession.
        if (this.currentSession) {
            try {
                await this.transcriptionService.stopTranscription(this.currentSession);
                this.currentSession = null;
            } catch (error) {
                logger.error(`❌ ${this.botName}: Error stopping legacy session:`, error);
            }
        }
    }

    // ── Chat history ───────────────────────────────────────────────────

    setupChatListener() {
        if (this.botEventBus) {
            this._onBusChatMessage = ({ username, message }) => {
                if (username && message) {
                    this.addChatMessage(username, message);
                }
            };
            this.botEventBus.on('chat-message', this._onBusChatMessage);
        }
        // Test/dev shapes occasionally pass a chatService with .on(); production
        // chatServiceWrapper exposes only getRecentMessages(), so this branch is
        // skipped at runtime.
        if (this.chatService && typeof this.chatService.on === 'function') {
            this.chatService.on('message', (data) => {
                if (data.username && data.message && !data.username.includes('🤖')) {
                    this.addChatMessage(data.username, data.message);
                }
            });
        } else if (!this.botEventBus) {
            logger.debug(`⚠️ ${this.botName}: No chat source available (no BotEventBus, no chatService.on)`);
        }
    }

    addChatMessage(username, message) {
        if (!username || username.includes('🤖')) return;
        this.recentChatMessages.push({ username, message, timestamp: new Date() });
        if (this.recentChatMessages.length > this.MAX_CHAT_HISTORY) {
            this.recentChatMessages = this.recentChatMessages.slice(-this.MAX_CHAT_HISTORY);
        }
    }

    async getChatHistory(limit = 30) {
        try {
            let messages = this.recentChatMessages.slice(-limit);
            if (messages.length === 0) {
                messages = await this.getChatHistoryFromDatabase(limit);
            }
            if (messages.length === 0) {
                // Parity with pre-refactor MovieBot behavior: provide minimal default
                // context so the LLM prompt isn't an empty chat block.
                messages = [
                    { username: 'viewer1', message: 'watching the stream', timestamp: new Date() },
                    { username: 'viewer2', message: 'cool content', timestamp: new Date() },
                ];
            }
            return messages;
        } catch (error) {
            logger.error(`❌ ${this.botName}: Failed to get chat history:`, error);
            return [];
        }
    }

    async getChatHistoryFromDatabase(limit = 30) {
        if (!this.db) return [];
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
                    logger.error(`❌ ${this.botName}: Error fetching messages from database:`, err);
                    resolve([]);
                    return;
                }
                const messages = rows
                    ? rows.reverse().map(row => ({
                        username: row.username,
                        message: row.message,
                        timestamp: row.timestamp,
                    }))
                    : [];
                resolve(messages);
            });
        });
    }

    // ── Validation ─────────────────────────────────────────────────────

    validateMeaningfulTranscription(transcriptionText) {
        if (!transcriptionText || typeof transcriptionText !== 'string') return null;
        const cleanText = transcriptionText.trim();
        if (cleanText.length < 10) return null;
        const meaningfulWords = cleanText
            .toLowerCase()
            .split(/\s+/)
            .filter(word => word.length > 2 && !STOPWORDS.has(word));
        if (meaningfulWords.length < 3) return null;
        return { cleanText, meaningfulWords };
    }

    // ── Logging ────────────────────────────────────────────────────────

    ensureLogDirectory() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    _todayLogFile(prefix) {
        return `${prefix}_${new Date().toISOString().split('T')[0]}.log`;
    }

    _trimPromptHistory() {
        if (this.promptHistory.length > 100) this.promptHistory.shift();
    }

    logEvent(eventType, data) {
        const entry = { timestamp: new Date().toISOString(), event: eventType, data };
        const logFile = path.join(this.logDir, this._todayLogFile(this.eventPrefix));
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
        this.promptHistory.push(entry);
        this._trimPromptHistory();
    }

    logPrompt(botUsername, fullPrompt, transcriptionText) {
        const entry = {
            timestamp: new Date().toISOString(),
            event: 'PROMPT_SENT',
            bot: botUsername,
            transcription: transcriptionText,
            fullPrompt,
            promptLength: fullPrompt.length,
        };
        const logFile = path.join(this.logDir, this._todayLogFile('prompts'));
        fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + '\n---\n');
        this.promptHistory.push(entry);
        this._trimPromptHistory();
        this.emit('prompt-logged', entry);
    }

    logBotResponse(botUsername, transcriptionText, responseMessage) {
        const entry = {
            timestamp: new Date().toISOString(),
            event: 'BOT_RESPONSE',
            bot: botUsername,
            transcription: transcriptionText,
            response: responseMessage,
            responseLength: responseMessage.length,
        };
        const logFile = path.join(this.logDir, this._todayLogFile('responses'));
        fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + '\n---\n');
        this.promptHistory.push(entry);
        this._trimPromptHistory();
        this.emit('response-logged', entry);
    }

    logBotError(botUsername, transcriptionText, errorMessage) {
        const entry = {
            timestamp: new Date().toISOString(),
            event: 'BOT_ERROR',
            bot: botUsername,
            transcription: transcriptionText,
            error: errorMessage,
        };
        const logFile = path.join(this.logDir, this._todayLogFile('errors'));
        fs.appendFileSync(logFile, JSON.stringify(entry, null, 2) + '\n---\n');
        this.promptHistory.push(entry);
        this._trimPromptHistory();
        this.emit('error-logged', entry);
    }

    getRecentLogs(limit = 50) {
        return this.promptHistory.slice(-limit);
    }

    // ── Shutdown ───────────────────────────────────────────────────────

    async stop() {
        if (this.botEventBus && this._onBusChatMessage) {
            this.botEventBus.off('chat-message', this._onBusChatMessage);
            this._onBusChatMessage = null;
        }
        if (this.transcriptionTimer) {
            clearTimeout(this.transcriptionTimer);
            this.transcriptionTimer = null;
        }
        if (this.isActive) {
            await this.stopCurrentTranscription();
            this.isActive = false;
        }
    }
}

module.exports = TranscriptionDrivenBotService;
