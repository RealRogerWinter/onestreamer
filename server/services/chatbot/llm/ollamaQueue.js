// Ollama request queue + model-availability cache for ChatBotLLMService.
// Owns the per-model concurrency limiting, the overflow queue, and the
// model-availability cache. The host service delegates the Ollama chat path
// here. Response cleanup + fallbacks are injected so this module stays free
// of prompt/personality concerns.

class OllamaQueue {
    // deps: { ollama, availableModels, logger, cleanResponse, getFallbackResponse }
    constructor({ ollama, availableModels, logger, cleanResponse, getFallbackResponse }) {
        this.ollama = ollama;
        this.availableModels = availableModels;
        this.logger = logger;
        this.cleanResponse = cleanResponse;
        this.getFallbackResponse = getFallbackResponse;

        // Cache for model availability checks (model -> { available: boolean, lastChecked: timestamp })
        this.modelCache = new Map();
        this.MODEL_CACHE_TTL = 60000; // 1 minute cache

        // Track concurrent requests per model
        this.activeRequests = new Map(); // model -> count
        this.MAX_CONCURRENT_PER_MODEL = 5; // Limit concurrent requests per model

        // Request queue for overflow
        this.requestQueue = [];
        this.processing = false;

        // Audit A6 (Plan 07): ollama.chat used to run with no timeout, so a
        // hung Ollama pinned a concurrency slot (and the serial queue
        // processor) forever. Each chat call now loses a Promise.race against
        // this deadline; queued entries older than 2× the deadline are aged
        // out with a fallback response instead of waiting indefinitely.
        const envTimeout = parseInt(process.env.OLLAMA_TIMEOUT_MS, 10);
        this.OLLAMA_TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 60000;
        this.QUEUE_MAX_AGE_MS = this.OLLAMA_TIMEOUT_MS * 2;
    }

    // Run ollama.chat with a hard deadline (audit A6). If the timeout wins the
    // race, this rejects and the underlying request's eventual settlement is
    // swallowed so it can't surface as an unhandled rejection. Callers'
    // existing finally blocks decrement the in-flight count on rejection, so
    // a timed-out call frees its concurrency slot.
    async chatWithTimeout(chatArgs, timeoutMs = this.OLLAMA_TIMEOUT_MS) {
        const chatPromise = this.ollama.chat(chatArgs);
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`Ollama chat timed out after ${timeoutMs}ms (model: ${chatArgs.model})`));
            }, timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
        });
        try {
            return await Promise.race([chatPromise, deadline]);
        } finally {
            clearTimeout(timer);
            // If the deadline won, the real request is still in flight; absorb
            // its eventual rejection.
            chatPromise.catch(() => {});
        }
    }

    // Resolve (with the fallback response) any queued request that has waited
    // longer than QUEUE_MAX_AGE_MS. Queue entries resolve rather than reject
    // by contract — LLM failures always surface as fallback messages — so
    // aging out follows the same shape as the chat error path.
    expireAgedRequests(now = Date.now()) {
        for (let i = this.requestQueue.length - 1; i >= 0; i--) {
            const request = this.requestQueue[i];
            if (now - request.timestamp > this.QUEUE_MAX_AGE_MS) {
                this.requestQueue.splice(i, 1);
                this.logger.debug(`⏰ Dropping queued request for model ${request.model}: aged out after ${now - request.timestamp}ms`);
                request.resolve({
                    message: this.getFallbackResponse([]),
                    exactPrompt: request.exactPrompt,
                    model: request.model,
                    error: `Queued request aged out after ${now - request.timestamp}ms (max ${this.QUEUE_MAX_AGE_MS}ms)`,
                    queued: true
                });
            }
        }
    }

    async queueRequest(modelToUse, systemPrompt, userPrompt, personality, modelConfig, exactPrompt) {
        return new Promise((resolve) => {
            this.requestQueue.push({
                model: modelToUse,
                systemPrompt,
                userPrompt,
                personality,
                modelConfig,
                exactPrompt,
                resolve,
                timestamp: Date.now()
            });

            this.logger.debug(`📋 Queued request for model ${modelToUse}. Queue length: ${this.requestQueue.length}`);
        });
    }

    async processQueue() {
        if (this.processing || this.requestQueue.length === 0) return;

        this.processing = true;

        try {
            // Drop entries that have already waited past the max age (audit A6).
            this.expireAgedRequests();

            // Process requests in order. A saturated model is SKIPPED (not a
            // loop break) so one model at its concurrency cap can't starve
            // other models' queued requests (audit A6).
            let i = 0;
            while (i < this.requestQueue.length) {
                const request = this.requestQueue[i];
                const activeCount = this.activeRequests.get(request.model) || 0;

                if (activeCount >= this.MAX_CONCURRENT_PER_MODEL) {
                    i++;
                    continue;
                }

                // Remove from queue and process
                this.requestQueue.splice(i, 1);
                this.activeRequests.set(request.model, activeCount + 1);

                try {
                    const response = await this.chatWithTimeout({
                        model: request.model,
                        messages: [
                            { role: 'system', content: request.systemPrompt },
                            { role: 'user', content: request.userPrompt }
                        ],
                        options: {
                            temperature: request.personality.temperature || request.modelConfig.temperature || 0.7,
                            max_tokens: request.modelConfig.maxTokens || 100,
                            top_p: 0.9,
                            num_ctx: 2048,
                            num_predict: request.modelConfig.maxTokens || 100
                        }
                    });

                    let message = response.message.content.trim();
                    message = this.cleanResponse(message);

                    const maxLength = request.modelConfig.maxTokens ? Math.min(200, request.modelConfig.maxTokens * 2) : 200;
                    if (message.length > maxLength) {
                        message = message.substring(0, maxLength - 3) + '...';
                    }

                    request.resolve({
                        message: message || this.getFallbackResponse([]),
                        exactPrompt: request.exactPrompt,
                        model: request.model,
                        queued: true,
                        queueTime: Date.now() - request.timestamp
                    });
                } catch (error) {
                    request.resolve({
                        message: this.getFallbackResponse([]),
                        exactPrompt: request.exactPrompt,
                        model: request.model,
                        error: error.message,
                        queued: true
                    });
                } finally {
                    const count = this.activeRequests.get(request.model) || 1;
                    this.activeRequests.set(request.model, Math.max(0, count - 1));
                }

                // The await above may have taken a while; restart the scan so
                // older entries (and newly-freed models) get first chance.
                i = 0;
            }
        } finally {
            this.processing = false;
        }
    }

    startRequestProcessor() {
        if (this._processorTimer) return; // idempotent
        // Periodically check and process queue. Guarded unref: this 1 Hz
        // tick must never be the only thing keeping a process alive —
        // constructing ChatBotService in a test used to leak it (audit B6).
        this._processorTimer = setInterval(() => {
            this.processQueue();

            // Clean up old cache entries
            const now = Date.now();
            for (const [model, cache] of this.modelCache.entries()) {
                if (now - cache.lastChecked > this.MODEL_CACHE_TTL) {
                    this.modelCache.delete(model);
                }
            }
        }, 1000); // Check every second
        if (typeof this._processorTimer.unref === 'function') this._processorTimer.unref();
    }

    stop() {
        if (this._processorTimer) {
            clearInterval(this._processorTimer);
            this._processorTimer = null;
        }
    }

    getModelConfig(modelName) {
        const model = this.availableModels.find(m => m.name === modelName);
        return model || {
            name: modelName,
            displayName: modelName,
            size: 'Unknown',
            description: 'Custom model',
            maxTokens: 100,
            temperature: 0.7
        };
    }

    async isModelAvailable(modelName) {
        // Check cache first
        const cached = this.modelCache.get(modelName);
        if (cached && (Date.now() - cached.lastChecked < this.MODEL_CACHE_TTL)) {
            return cached.available;
        }

        // Otherwise check with Ollama
        try {
            const response = await fetch(`${this.ollama.config.host}/api/tags`);
            if (response.ok) {
                const data = await response.json();
                const models = data.models || [];
                const available = models.some(m => m.name.includes(modelName));

                // Update cache
                this.modelCache.set(modelName, {
                    available,
                    lastChecked: Date.now()
                });

                return available;
            }
        } catch (error) {
            this.logger.debug(`⚠️ Error checking model ${modelName} availability:`, error.message);
        }
        return false;
    }
}

module.exports = { OllamaQueue };
