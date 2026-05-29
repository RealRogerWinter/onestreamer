// MovieBot + VisionBot comment dispatch, extracted from ChatBotService
// (behavior-preserving). Owns generateMovieComment / generateVisionCommentForBot.
// Shares the owner's `bots` Map and delegates cleanup back through the owner so
// existing test spies still fire. The duplicated output-moderation gate is
// extracted into _runOutputModerationGate; the two callers differ only in the
// ctx they pass and in how they react to a drop (movie returns a failure
// object, vision throws), so the gate signals a drop via its return value and
// each caller decides.

const logger = require('../../bootstrap/logger').child({ svc: 'ChatBotService' });
const { isBotExpired, buildResponsePersonality, parsePersonalityTraits } = require('./responsePolicy');

class BotMessageDispatch {
    /**
     * @param {object} deps
     * @param {object} deps.owner - the ChatBotService instance (back-ref for
     *   bots Map, repo, llmService, moderationService, chatServiceUrl, cleanup).
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

    // Shared output-moderation gate (PR-M4 / ADR-0013). Returns:
    //   { dropped: false } when allowed (or moderation not wired / gate threw)
    //   { dropped: true, reason, eventId } when the moderation service blocks
    // Callers decide how to surface a drop (movie -> failure object, vision ->
    // throw). Fail-open semantics preserved: a thrown gate logs and allows.
    async _runOutputModerationGate(message, ctx) {
        if (!(message && this.owner.moderationService &&
            typeof this.owner.moderationService.checkBotOutput === 'function')) {
            return { dropped: false };
        }
        try {
            const gate = await this.owner.moderationService.checkBotOutput(message, ctx);
            if (gate && gate.allowed === false) {
                return { dropped: true, reason: gate.reason, eventId: gate.eventId || null };
            }
            return { dropped: false };
        } catch (err) {
            logger.error('❌ ChatBotService: moderation gate threw:', err.message);
            // Fail open here — a bug in the moderation gate shouldn't
            // silence the bot. The next-tier defense (Stage 1+2 on the
            // STREAMER's audio) still applies, and outright slurs in
            // the bot reply would have to come from a Groq response
            // that escaped its own safety filters.
            return { dropped: false };
        }
    }

    async generateMovieComment(bot, moviePrompt, chatHistory) {
        try {
            logger.debug(`🎬 ChatBotService: Generating movie comment for ${bot.username} (ID: ${bot.id})`);

            // Find the bot instance
            const botInstance = this.owner.bots.get(bot.id);
            logger.debug(`🎬 ChatBotService: Bot instance found: ${!!botInstance}, connected: ${botInstance?.connected}`);
            logger.debug(`🎬 ChatBotService: Available bot IDs: ${Array.from(this.owner.bots.keys())}`);

            if (!botInstance) {
                logger.error(`❌ ChatBotService: Bot ${bot.id} not found in bots map`);
                return { success: false, error: 'Bot not found in active bots' };
            }

            if (!botInstance.connected) {
                logger.error(`❌ ChatBotService: Bot ${bot.id} (${bot.username}) not connected to chat service`);
                return { success: false, error: 'Bot not connected to chat service' };
            }

            // Check if this is a temporary bot that has expired
            if (isBotExpired(botInstance.data)) {
                logger.debug(`🚫 ChatBotService: Bot ${bot.id} (${bot.username}) has expired, cannot send movie comment`);
                // Trigger cleanup
                this.owner.cleanupExpiredBots();
                return { success: false, error: 'Bot has expired' };
            }

            // Get bot's personality traits (+ creativity temperature)
            const personality = buildResponsePersonality(botInstance.data);

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
            //
            // ctx.streamerId is for admin-diagnostics display only. The
            // streamer's socket id isn't readily available in this scope
            // (ChatBotService doesn't hold streamService), so we pass null and
            // the admin UI surfaces just the bot username + transcript_excerpt
            // for the dropped output.
            if (response && response.message) {
                const gate = await this._runOutputModerationGate(response.message, {
                    streamerId: null,
                    botUsername: bot.username,
                });
                if (gate.dropped) {
                    logger.debug(`🛡️ ChatBotService: MovieBot reply from ${bot.username} dropped by moderation (reason=${gate.reason}, eventId=${gate.eventId})`);
                    return { success: false, error: `moderation_dropped:${gate.reason}`, moderation_event_id: gate.eventId };
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
                        chat_service_url: this.owner.chatServiceUrl,
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
                    chatServiceUrl: this.owner.chatServiceUrl
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
        const botInstance = this.owner.bots.get(bot.id);
        if (!botInstance || !botInstance.connected) {
            return { success: false, error: 'Bot not connected' };
        }
        if (isBotExpired(botInstance.data || {})) {
            this.owner.cleanupExpiredBots();
            return { success: false, error: 'Bot has expired' };
        }

        const personality = parsePersonalityTraits(botInstance.data || {});

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

        // Output moderation gate (same as MovieBot). A drop throws here so
        // VisionBotService can record the reason in its stats/backoff state.
        if (response && response.message) {
            const gate = await this._runOutputModerationGate(response.message, {
                streamerId: null,
                botUsername: bot.username,
                botType: 'vision',
                frame_path: frame.sourceSegment,
            });
            if (gate.dropped) {
                const err = new Error(`moderation_dropped:${gate.reason}`);
                err.droppedReason = 'moderated';
                throw err;
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
}

module.exports = BotMessageDispatch;
