const path = require('path');
const TranscriptionDrivenBotService = require('./TranscriptionDrivenBotService');
const { GroqRateLimitError, GroqUnavailableError } = require('./ChatBotLLMService');

const logger = require('../bootstrap/logger').child({ svc: 'VisionBotService' });
const DEFAULT_VISION_PROMPT = `You are a viewer watching this stream. A screenshot of the current moment is attached, along with the last 45 seconds of spoken audio. React briefly and in character to what you see and hear. Keep it under 80 characters. Do not describe the image literally — react like a chat viewer would.

The most recent spoken content was:

[TRANSCRIPTION_DATA]`;

const SKIP_REASONS = [
    'no_egress',
    'no_frame',
    'no_bots',
    'groq_429',
    'groq_5xx',
    'moderated',
    'kill_switch',
    'url_relay_disallowed',
    'streamer_changed',
    'duplicate_session',
    'in_backoff',
    'throttled',
    'unknown',
];

/**
 * VisionBotService — sibling of MovieBotService.
 *
 * On each transcription window completion, captures a screenshot from the
 * LiveKit Egress HLS recording (via EgressFrameCaptureService) aligned to
 * the transcription's end time, then dispatches a vision-model prompt to
 * each enabled chatbot account in turn (with staggered delays). Posts the
 * generated commentary to chat via the bot's existing socket.
 *
 * Trigger model: both BotEventBus 'moviebot-transcription-complete'
 * events (when MovieBot is also driving transcriptions) AND its own
 * scheduler (the base class's). Dedupes by sessionId so a transcription
 * shared with MovieBot fires VisionBot exactly once.
 */
class VisionBotService extends TranscriptionDrivenBotService {
    constructor({
        transcriptionService,
        chatBotService,
        chatService,
        database,
        botEventBus,
        frameCaptureService,
        streamService,
        continuousRecordingService,
        moderationService = null,
    }) {
        super({
            botName: 'VisionBotService',
            eventPrefix: 'visionbot',
            configTableName: 'visionbot_config',
            logDir: path.join(__dirname, '..', '..', 'logs', 'visionbot'),
            transcriptionService,
            chatBotService,
            chatService,
            database,
            botEventBus,
        });

        this.frameCaptureService = frameCaptureService;
        this.streamService = streamService;
        this.continuousRecordingService = continuousRecordingService;
        // OmniImageMod PR 3 (ADR-0021): optional moderation gate. When wired
        // and enabled, every captured frame goes through omni-moderation
        // before the bot dispatch fires. Service is null in test setups
        // and in production deployments that don't have OPENAI_API_KEY.
        this.moderationService = moderationService;

        this.defaultPromptTemplate = DEFAULT_VISION_PROMPT;

        this.activeController = null;
        this._recentSessionIds = [];
        this._lastCycleStartedAt = 0;
        this.MAX_DEDUP_HISTORY = 10;

        this.stats = {
            cycles_attempted: 0,
            cycles_succeeded: 0,
            cycles_dropped: Object.fromEntries(SKIP_REASONS.map(r => [r, 0])),
            last_groq_latency_ms: null,
        };

        if (this.botEventBus) {
            this._onMovieBotComplete = (payload) => this._handleBusEvent(payload);
            this.botEventBus.on('moviebot-transcription-complete', this._onMovieBotComplete);
        }

        setTimeout(() => this.loadConfigFromDatabase(), 100);

        logger.debug('🔍 VisionBotService: Initialized');
    }

    // OmniImageMod PR 3: late-injection setter for ModerationService.
    // ModerationService is constructed inline in server/index.js AFTER the
    // bootstrap factory builds VisionBotService (because Moderation init is
    // async — runs schema apply, seed verification, etc. inside an
    // initialize() that the factory can't await). The setter is called
    // from server/index.js after moderationService.initialize() resolves.
    setModerationService(moderationService) {
        this.moderationService = moderationService;
    }

    // ── Base-class hooks ───────────────────────────────────────────────

    getDefaultConfig() {
        return {
            enabled: false,
            streamerId: null,
            vision_prompt_template: this.defaultPromptTemplate,
            transcription_frequency_s: 120,
            transcription_duration_s: 45,
            // The base class scheduler reads this — keep it in sync with
            // transcription_frequency_s.
            transcriptionFrequency: 120,
            transcriptionDuration: 45,
            chatHistoryLimit: 30,
            image_resolution_px: 384,
            image_quality: 70,
            vision_model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            max_response_tokens: 150,
            temperature: 0.7,
            max_bots_per_cycle: 3,
            frame_retention_hours: 1,
            allow_url_relay: false,
            last_groq_429_at: null,
            consecutive_failures: 0,
            last_success_at: null,
            last_error_reason: null,
        };
    }

    parseConfigRow(row) {
        const cfg = {
            enabled: row.enabled === 1,
            streamerId: row.streamer_id || null,
            vision_prompt_template: row.vision_prompt_template || this.defaultPromptTemplate,
            transcription_frequency_s: row.transcription_frequency_s || 120,
            transcription_duration_s: row.transcription_duration_s || 45,
            chatHistoryLimit: 30,
            image_resolution_px: row.image_resolution_px || 384,
            image_quality: row.image_quality || 70,
            vision_model: row.vision_model || 'meta-llama/llama-4-scout-17b-16e-instruct',
            max_response_tokens: row.max_response_tokens || 150,
            temperature: typeof row.temperature === 'number' ? row.temperature : 0.7,
            max_bots_per_cycle: row.max_bots_per_cycle || 3,
            frame_retention_hours: row.frame_retention_hours || 1,
            allow_url_relay: row.allow_url_relay === 1,
            last_groq_429_at: row.last_groq_429_at || null,
            consecutive_failures: row.consecutive_failures || 0,
            last_success_at: row.last_success_at || null,
            last_error_reason: row.last_error_reason || null,
        };
        // Mirror the *_s fields under the names the base class scheduler reads.
        cfg.transcriptionFrequency = cfg.transcription_frequency_s;
        cfg.transcriptionDuration = cfg.transcription_duration_s;
        return cfg;
    }

    afterConfigLoaded(_row) {
        // Push retention setting down to the frame capture service so its
        // hourly purge respects the admin value.
        if (this.frameCaptureService && typeof this.frameCaptureService.setRetentionHours === 'function') {
            this.frameCaptureService.setRetentionHours(this.config.frame_retention_hours);
        }
    }

    buildSaveConfigSQL(_includeApiKey, _apiKey) {
        return {
            query: `
                INSERT OR REPLACE INTO visionbot_config (
                    id, enabled, streamer_id, vision_prompt_template,
                    transcription_frequency_s, transcription_duration_s,
                    image_resolution_px, image_quality, vision_model,
                    max_response_tokens, temperature, max_bots_per_cycle,
                    frame_retention_hours, allow_url_relay,
                    last_groq_429_at, consecutive_failures,
                    last_success_at, last_error_reason, updated_at
                ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `,
            params: [
                this.config.enabled ? 1 : 0,
                this.currentStreamerId || null,
                this.config.vision_prompt_template || this.defaultPromptTemplate,
                this.config.transcription_frequency_s,
                this.config.transcription_duration_s,
                this.config.image_resolution_px,
                this.config.image_quality,
                this.config.vision_model,
                this.config.max_response_tokens,
                this.config.temperature,
                this.config.max_bots_per_cycle,
                this.config.frame_retention_hours,
                this.config.allow_url_relay ? 1 : 0,
                this.config.last_groq_429_at,
                this.config.consecutive_failures || 0,
                this.config.last_success_at,
                this.config.last_error_reason,
            ],
        };
    }

    async onTranscriptionComplete(transcription, sessionData) {
        await this._runCycle(transcription, sessionData.endTime, sessionData.sessionId);
    }

    // ── Bus event path (when MovieBot is also enabled) ─────────────────

    async _handleBusEvent({ streamerId, sessionId, transcription, endTime }) {
        if (!this.isActive) return;
        // No streamerId guard: OneStreamer is one-streamer-at-a-time, but
        // MovieBot and VisionBot can be enabled with different identifiers
        // for the same physical stream (mediasoup socket id vs url-stream id).
        // The old guard rejected every bus event when those differ. Takeover
        // safety is enforced downstream via streamGeneration (frame-cache key
        // + dispatch-time check in ChatBotService.generateVisionCommentForBot).
        await this._runCycle(transcription, endTime, sessionId);
    }

    // ── Cycle runner ───────────────────────────────────────────────────

    async _runCycle(transcription, endTime, sessionId) {
        this.stats.cycles_attempted += 1;

        // Cadence throttle. With MovieBot also enabled, bus events fire every
        // ~50 s — without this gate, transcription_frequency_s in
        // visionbot_config has no effect (admin knob looks decorative). Set
        // at the top so failed cycles also burn the window; predictable
        // upper bound on call rate.
        const freqMs = (this.config.transcription_frequency_s || 120) * 1000;
        if (this._lastCycleStartedAt && (Date.now() - this._lastCycleStartedAt) < freqMs) {
            this._recordSkip('throttled');
            return;
        }
        this._lastCycleStartedAt = Date.now();

        if (sessionId && this._recentSessionIds.includes(sessionId)) {
            this._recordSkip('duplicate_session');
            return;
        }
        if (sessionId) {
            this._recentSessionIds.push(sessionId);
            if (this._recentSessionIds.length > this.MAX_DEDUP_HISTORY) {
                this._recentSessionIds.shift();
            }
        }

        if (process.env.VISIONBOT_KILL_SWITCH === '1') {
            this._recordSkip('kill_switch');
            return;
        }
        if (!this.continuousRecordingService || !this.continuousRecordingService.isRecording) {
            this._recordSkip('no_egress');
            return;
        }
        // URL-relay streams register themselves on StreamService via
        // setStreamer(urlId) WITHOUT a streamType, so getStreamType() would
        // report the 'webcam' default rather than 'url-relay'. Detect the
        // relay reliably off the streamer id prefix instead — ViewBotURLService
        // mints these as `url-stream-<ts>-<n>` (see _registerAsCurrentStreamer).
        const isUrlRelay = typeof this.currentStreamerId === 'string'
            && this.currentStreamerId.startsWith('url-stream-');
        if (isUrlRelay && !this.config.allow_url_relay) {
            this._recordSkip('url_relay_disallowed');
            return;
        }
        if (this._inBackoff()) {
            this._recordSkip('in_backoff');
            return;
        }

        const streamGeneration = (this.streamService && this.streamService.streamGeneration) || 0;
        const frame = await this.frameCaptureService.captureFrame(
            this.currentStreamerId,
            endTime instanceof Date ? endTime : new Date(endTime),
            streamGeneration,
        );
        if (!frame) {
            this._recordSkip('no_frame');
            return;
        }

        // OmniImageMod PR 3 (ADR-0021): image-moderation gate. Runs BEFORE
        // the bot dispatch setTimeouts are scheduled — so a flag halts the
        // cycle and no chat message is posted. This costs ~0.5–2s of
        // latency per cycle (OpenAI moderation RTT) but is required to
        // prevent the bot from commenting on content that's about to get
        // the streamer banned. Fail-open: if the gate throws, the cycle
        // continues (a bug in moderation must not silence the bot).
        if (this.moderationService && typeof this.moderationService.handleVisionFrame === 'function') {
            try {
                const modResult = await this.moderationService.handleVisionFrame({
                    streamerId: this.currentStreamerId,
                    frame,
                    sessionId,
                    endTime,
                    transcription,
                });
                if (modResult && (modResult.final_decision === 'auto_ban' || modResult.final_decision === 'auto_skip')) {
                    this._recordSkip('moderated');
                    return;
                }
            } catch (err) {
                logger.warn(`⚠️ VisionBotService: image-moderation gate threw: ${err && err.message}`);
            }
        }

        const bots = await this._getEnabledBots();
        if (!bots || bots.length === 0) {
            this._recordSkip('no_bots');
            return;
        }
        const capped = bots.slice(0, this.config.max_bots_per_cycle || 3);

        if (this.activeController) {
            try { this.activeController.abort(); } catch (_) {}
        }
        this.activeController = new AbortController();
        const abortSignal = this.activeController.signal;

        const chatHistory = await this.getChatHistory(this.config.chatHistoryLimit || 30);

        let cumulativeDelay = 0;
        for (let i = 0; i < capped.length; i++) {
            const bot = capped[i];
            if (i > 0) {
                cumulativeDelay += 4000 + Math.floor(Math.random() * 4000) * i;
            }
            const botDelay = cumulativeDelay;
            setTimeout(() => {
                this._dispatchForBot(bot, frame, transcription, chatHistory, abortSignal).catch(() => {});
            }, botDelay);
        }

        this.stats.cycles_succeeded += 1;
    }

    async _dispatchForBot(bot, frame, transcription, chatHistory, abortSignal) {
        if (abortSignal && abortSignal.aborted) return;
        const t0 = Date.now();
        try {
            await this.chatBotService.generateVisionCommentForBot({
                bot,
                frame,
                transcription,
                chatHistory,
                abortSignal,
                sourceStreamerId: frame.streamerId,
                sourceStreamGeneration: frame.streamGeneration,
                visionPromptTemplate: this.config.vision_prompt_template,
                model: this.config.vision_model,
                maxTokens: this.config.max_response_tokens,
                temperature: this.config.temperature,
            });
            this.stats.last_groq_latency_ms = Date.now() - t0;
            this._recordSuccess();
        } catch (err) {
            this._recordFailure(err);
            this.logBotError(bot.username || bot.name || 'unknown', transcription || '', (err && err.message) || 'unknown');
        }
    }

    _getEnabledBots() {
        if (!this.db) return Promise.resolve([]);
        return new Promise((resolve) => {
            this.db.all(
                `SELECT * FROM chatbots WHERE vision_bot_enabled = 1 AND is_enabled = 1`,
                [],
                (err, rows) => {
                    if (err) {
                        logger.error('❌ VisionBotService: Error fetching enabled bots:', err);
                        resolve([]);
                        return;
                    }
                    resolve(rows || []);
                },
            );
        });
    }

    _inBackoff() {
        if (!this.config.last_groq_429_at) return false;
        const last = new Date(this.config.last_groq_429_at).getTime();
        if (!Number.isFinite(last)) return false;
        const cf = this.config.consecutive_failures || 0;
        const cooldownMs = Math.min(30_000 * Math.pow(2, cf), 30 * 60 * 1000);
        return (Date.now() - last) < cooldownMs;
    }

    _recordSuccess() {
        this.config.consecutive_failures = 0;
        this.config.last_success_at = new Date().toISOString();
        this.config.last_error_reason = null;
        this.saveConfigToDatabase();
    }

    _recordFailure(err) {
        if (err && err.name === 'GroqRateLimitError') {
            this._recordSkip('groq_429');
            this.config.last_groq_429_at = new Date().toISOString();
            this.config.consecutive_failures = (this.config.consecutive_failures || 0) + 1;
            this.config.last_error_reason = `429 (retry-after ${err.retryAfterSeconds}s)`;
        } else if (err && err.name === 'GroqUnavailableError') {
            this._recordSkip('groq_5xx');
            this.config.consecutive_failures = (this.config.consecutive_failures || 0) + 1;
            this.config.last_error_reason = String(err.message || '').substring(0, 200);
        } else if (err && err.droppedReason) {
            this._recordSkip(err.droppedReason);
            this.config.last_error_reason = String(err.message || '').substring(0, 200);
        } else {
            this._recordSkip('unknown');
            this.config.last_error_reason = String((err && err.message) || 'unknown').substring(0, 200);
        }
        this.saveConfigToDatabase();
    }

    _recordSkip(reason) {
        if (this.stats.cycles_dropped[reason] !== undefined) {
            this.stats.cycles_dropped[reason] += 1;
        } else {
            this.stats.cycles_dropped.unknown += 1;
        }
    }

    // ── Status / config update ─────────────────────────────────────────

    getStatus() {
        return {
            enabled: this.config && this.config.enabled || false,
            isActive: this.isActive || false,
            currentStreamerId: this.currentStreamerId || null,
            in_flight: !!(this.activeController && !this.activeController.signal.aborted),
            cycles_attempted: this.stats.cycles_attempted,
            cycles_succeeded: this.stats.cycles_succeeded,
            cycles_dropped: this.stats.cycles_dropped,
            last_groq_latency_ms: this.stats.last_groq_latency_ms,
            consecutive_failures: (this.config && this.config.consecutive_failures) || 0,
            last_success_at: (this.config && this.config.last_success_at) || null,
            last_error_reason: (this.config && this.config.last_error_reason) || null,
            last_groq_429_at: (this.config && this.config.last_groq_429_at) || null,
            kill_switch_env: process.env.VISIONBOT_KILL_SWITCH === '1',
            config: this.config || this.getDefaultConfig(),
        };
    }

    updateConfig(newConfig) {
        if (!this.config) this.config = this.getDefaultConfig();
        if (typeof newConfig.transcription_frequency_s === 'number') {
            this.config.transcription_frequency_s = Math.max(60, newConfig.transcription_frequency_s);
            this.config.transcriptionFrequency = this.config.transcription_frequency_s;
        }
        if (typeof newConfig.transcription_duration_s === 'number') {
            this.config.transcription_duration_s = Math.max(10, Math.min(120, newConfig.transcription_duration_s));
            this.config.transcriptionDuration = this.config.transcription_duration_s;
        }
        if (typeof newConfig.max_bots_per_cycle === 'number') {
            this.config.max_bots_per_cycle = Math.max(1, Math.min(5, newConfig.max_bots_per_cycle));
        }
        if (typeof newConfig.frame_retention_hours === 'number') {
            this.config.frame_retention_hours = Math.max(1, Math.min(24, newConfig.frame_retention_hours));
            if (this.frameCaptureService && typeof this.frameCaptureService.setRetentionHours === 'function') {
                this.frameCaptureService.setRetentionHours(this.config.frame_retention_hours);
            }
        }
        if (typeof newConfig.image_resolution_px === 'number') {
            this.config.image_resolution_px = Math.max(128, Math.min(1024, newConfig.image_resolution_px));
        }
        if (typeof newConfig.image_quality === 'number') {
            this.config.image_quality = Math.max(20, Math.min(100, newConfig.image_quality));
        }
        if (typeof newConfig.vision_prompt_template === 'string') {
            this.config.vision_prompt_template = newConfig.vision_prompt_template;
        }
        if (typeof newConfig.vision_model === 'string') {
            this.config.vision_model = newConfig.vision_model;
        }
        if (typeof newConfig.max_response_tokens === 'number') {
            this.config.max_response_tokens = Math.max(20, Math.min(500, newConfig.max_response_tokens));
        }
        if (typeof newConfig.temperature === 'number') {
            this.config.temperature = Math.max(0, Math.min(2, newConfig.temperature));
        }
        if (typeof newConfig.allow_url_relay === 'boolean') {
            this.config.allow_url_relay = newConfig.allow_url_relay;
        }
        this.saveConfigToDatabase();
        this.logEvent('CONFIG_UPDATED', newConfig);
        return { success: true, config: this.config };
    }

    async stop() {
        if (this.botEventBus && this._onMovieBotComplete) {
            this.botEventBus.off('moviebot-transcription-complete', this._onMovieBotComplete);
            this._onMovieBotComplete = null;
        }
        if (this.activeController) {
            try { this.activeController.abort(); } catch (_) {}
            this.activeController = null;
        }
        await super.stop();
    }
}

module.exports = VisionBotService;
