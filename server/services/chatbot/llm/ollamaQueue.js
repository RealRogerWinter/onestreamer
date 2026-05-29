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

        // Process requests in order, checking model availability
        while (this.requestQueue.length > 0) {
            const request = this.requestQueue[0];
            const activeCount = this.activeRequests.get(request.model) || 0;

            if (activeCount < this.MAX_CONCURRENT_PER_MODEL) {
                // Remove from queue and process
                this.requestQueue.shift();

                // Process the queued request
                this.activeRequests.set(request.model, activeCount + 1);

                try {
                    const response = await this.ollama.chat({
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
            } else {
                // Can't process this model right now, try next
                break;
            }
        }

        this.processing = false;
    }

    startRequestProcessor() {
        // Periodically check and process queue
        setInterval(() => {
            this.processQueue();

            // Clean up old cache entries
            const now = Date.now();
            for (const [model, cache] of this.modelCache.entries()) {
                if (now - cache.lastChecked > this.MODEL_CACHE_TTL) {
                    this.modelCache.delete(model);
                }
            }
        }, 1000); // Check every second
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
