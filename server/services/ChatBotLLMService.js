const { Ollama } = require('ollama');
const database = require('../database/database');

const logger = require('../bootstrap/logger').child({ svc: 'ChatBotLLMService' });
const { GROQ_MODELS, OLLAMA_MODELS, FALLBACK_RESPONSES, DEFAULT_GLOBAL_PROMPT } = require('./llm/modelCatalog');
const promptBuilders = require('./chatbot/llm/promptBuilders');
const groqConfigStore = require('./chatbot/llm/groqConfigStore');
const { OllamaQueue } = require('./chatbot/llm/ollamaQueue');
const {
    GroqClient,
    GroqRateLimitError,
    GroqUnavailableError,
} = require('./chatbot/llm/groqClient');

class ChatBotLLMService {
    constructor() {
        this.ollama = new Ollama({
            host: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'
        });
        this.model = process.env.OLLAMA_MODEL || 'mistral';
        this.isAvailable = false;
        this.globalPrompt = null;

        // Groq configuration
        this.groqEnabled = false;
        this.groqApiKey = process.env.GROQ_API_KEY || null;
        this.groqModel = 'llama-3.1-8b-instant'; // Default Groq model
        this.groqApiUrl = 'https://api.groq.com/openai/v1/chat/completions';

        // Available Groq models with their specifications
        this.groqModels = GROQ_MODELS;

        // Define available lightweight models with their info
        this.availableModels = OLLAMA_MODELS;

        this.fallbackResponses = FALLBACK_RESPONSES;

        // Ollama request queue + model-availability cache. Owns modelCache /
        // activeRequests / requestQueue state; alias them so callers that read
        // them directly (checkAvailability, getStats) keep working.
        this.ollamaQueue = new OllamaQueue({
            ollama: this.ollama,
            availableModels: this.availableModels,
            logger,
            cleanResponse: (msg) => this.cleanResponse(msg),
            getFallbackResponse: (ctx) => this.getFallbackResponse(ctx),
        });
        this.modelCache = this.ollamaQueue.modelCache;
        this.MODEL_CACHE_TTL = this.ollamaQueue.MODEL_CACHE_TTL;
        this.activeRequests = this.ollamaQueue.activeRequests;
        this.MAX_CONCURRENT_PER_MODEL = this.ollamaQueue.MAX_CONCURRENT_PER_MODEL;

        // Groq API client. Reads key/model/url lazily so post-construction
        // mutation (enableGroq, tests) is honored.
        this.groqClient = new GroqClient({
            getApiKey: () => this.groqApiKey,
            getModel: () => this.groqModel,
            getApiUrl: () => this.groqApiUrl,
            logger,
        });

        this.loadConfiguration();
        this.checkAvailability();

        // Start request processor
        this.startRequestProcessor();

        // Load Groq configuration from database on initialization
        this.loadGroqConfig();
    }

    async loadGroqConfig() {
        return groqConfigStore.loadGroqConfig(this, database, logger);
    }

    saveGroqConfig() {
        return groqConfigStore.saveGroqConfig(this, database, logger);
    }

    async checkAvailability() {
        try {
            const response = await fetch(`${this.ollama.config.host}/api/tags`);
            if (response.ok) {
                const data = await response.json();
                const models = data.models || [];
                this.isAvailable = models.some(m => m.name.includes(this.model));

                if (!this.isAvailable) {
                    logger.debug(`⚠️ ChatBot LLM: Model ${this.model} not found. Available models:`, models.map(m => m.name));
                    logger.debug(`💡 ChatBot LLM: To install, run: ollama pull ${this.model}`);
                } else {
                    logger.debug(`✅ ChatBot LLM: Connected to Ollama with model ${this.model}`);
                }

                // Pre-cache available models
                for (const model of models) {
                    const modelName = model.name.split(':')[0]; // Remove tag if present
                    this.modelCache.set(modelName, {
                        available: true,
                        lastChecked: Date.now()
                    });
                }
            }
        } catch (error) {
            logger.debug('⚠️ ChatBot LLM: Ollama not available. Using fallback responses.');
            logger.debug('💡 To enable AI responses, install Ollama from https://ollama.ai');
            this.isAvailable = false;
        }
    }

    // Shared chat path for generateResponse / generateMovieResponse. The two
    // callers differ only in which prompt builders they used (handled before
    // the call) and the Groq log string.
    async _runChat({ systemPrompt, userPrompt, botModel, personality, groqLogLabel }) {
        // Check if Groq is enabled
        if (this.groqEnabled && this.groqApiKey) {
            try {
                logger.debug(groqLogLabel);
                const result = await this.callGroqAPI(systemPrompt, userPrompt);
                return {
                    message: this.cleanResponse(result.message),
                    exactPrompt: `[GROQ API]\n[SYSTEM MESSAGE]\n${systemPrompt}\n\n[USER MESSAGE]\n${userPrompt}`,
                    model: 'groq:' + this.groqModel,
                    responseTime: result.responseTime
                };
            } catch (error) {
                logger.error('❌ Groq API failed, falling back to Ollama:', error.message);
                // Fall back to Ollama if Groq fails
            }
        }

        // Original Ollama implementation (fallback)
        // Use bot-specific model if provided, otherwise use global default
        const modelToUse = botModel || this.model;

        // Get model configuration
        const modelConfig = this.getModelConfig(modelToUse);

        // Create the exact prompt format that will be sent to the model
        const exactPrompt = `[MODEL: ${modelToUse}]\n[SYSTEM MESSAGE]\n${systemPrompt}\n\n[USER MESSAGE]\n${userPrompt}`;

        // Check if the specific model is available (with caching)
        const modelAvailable = await this.isModelAvailable(modelToUse);

        if (!modelAvailable) {
            logger.debug(`⚠️ Model ${modelToUse} not available, using fallback responses`);
            const fallbackMessage = this.getFallbackResponse(personality.context || []);
            return {
                message: fallbackMessage,
                exactPrompt: exactPrompt,
                model: modelToUse,
                fallback: true
            };
        }

        // Check concurrent requests for this model
        const activeCount = this.activeRequests.get(modelToUse) || 0;
        if (activeCount >= this.MAX_CONCURRENT_PER_MODEL) {
            logger.debug(`⚠️ Model ${modelToUse} has ${activeCount} active requests, queueing...`);
            return this.queueRequest(modelToUse, systemPrompt, userPrompt, personality, modelConfig, exactPrompt);
        }

        // Increment active request count
        this.activeRequests.set(modelToUse, activeCount + 1);

        try {
            // Timeout-wrapped (audit A6): a hung Ollama otherwise pins this
            // model's concurrency slot forever. On timeout the catch below
            // returns the fallback and the finally frees the slot.
            const response = await this.ollamaQueue.chatWithTimeout({
                model: modelToUse,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                options: {
                    temperature: personality.temperature || modelConfig.temperature || 0.7,
                    max_tokens: modelConfig.maxTokens || 100,
                    top_p: 0.9,
                    num_ctx: 2048, // Context window
                    num_predict: modelConfig.maxTokens || 100
                }
            });

            let message = response.message.content.trim();

            // Clean up the response
            message = this.cleanResponse(message);

            // Ensure response isn't too long for chat
            const maxLength = modelConfig.maxTokens ? Math.min(200, modelConfig.maxTokens * 2) : 200;
            if (message.length > maxLength) {
                message = message.substring(0, maxLength - 3) + '...';
            }

            const finalMessage = message || this.getFallbackResponse(personality.context || []);

            return {
                message: finalMessage,
                exactPrompt: exactPrompt,
                model: modelToUse,
                responseTime: response.eval_count ? response.eval_duration / 1000000 : null // Convert to ms
            };
        } catch (error) {
            logger.error(`ChatBot LLM generation error for model ${modelToUse}:`, error.message);
            const fallbackMessage = this.getFallbackResponse(personality.context || []);
            return {
                message: fallbackMessage,
                exactPrompt: exactPrompt,
                model: modelToUse,
                error: error.message
            };
        } finally {
            // Decrement active request count
            const count = this.activeRequests.get(modelToUse) || 1;
            this.activeRequests.set(modelToUse, Math.max(0, count - 1));

            // Process queued requests
            this.processQueue();
        }
    }

    async generateMovieResponse(prompt, transcriptPrompt, context = [], personality = {}, botModel = null, botUsername = null) {
        const systemPrompt = await this.buildMovieSystemPrompt(prompt, personality, botUsername);
        const userPrompt = this.buildMovieUserPrompt(transcriptPrompt, context, botUsername);
        return this._runChat({
            systemPrompt,
            userPrompt,
            botModel,
            personality: { ...personality, context },
            groqLogLabel: '🚀 Using Groq API for MovieBot response',
        });
    }

    async generateResponse(prompt, context = [], personality = {}, botModel = null, botUsername = null) {
        const systemPrompt = await this.buildSystemPrompt(prompt, personality, botUsername);
        const userPrompt = this.buildUserPrompt(context, botUsername);
        return this._runChat({
            systemPrompt,
            userPrompt,
            botModel,
            personality: { ...personality, context },
            groqLogLabel: '🚀 Using Groq API for chatbot response',
        });
    }

    async queueRequest(modelToUse, systemPrompt, userPrompt, personality, modelConfig, exactPrompt) {
        return this.ollamaQueue.queueRequest(modelToUse, systemPrompt, userPrompt, personality, modelConfig, exactPrompt);
    }

    async processQueue() {
        return this.ollamaQueue.processQueue();
    }

    startRequestProcessor() {
        return this.ollamaQueue.startRequestProcessor();
    }

    // Stop the queue's processor interval (tests/shutdown).
    stop() {
        return this.ollamaQueue.stop();
    }

    getModelConfig(modelName) {
        return this.ollamaQueue.getModelConfig(modelName);
    }

    // Single load path for the DB-backed chatbot config. Reads both the global
    // prompt and the default LLM model in one query so the prompt is loaded in
    // exactly one place. On a DB error, falls back to the shared
    // DEFAULT_GLOBAL_PROMPT constant (the same default seeded into the schema).
    async loadConfiguration() {
        try {
            const config = await database.getAsync('SELECT global_prompt, llm_model FROM chatbot_config WHERE id = 1');
            this.globalPrompt = config?.global_prompt || '';
            if (config?.llm_model) {
                this.model = config.llm_model;
                logger.debug(`🤖 LLM: Loaded model from config: ${this.model}`);
            }
        } catch (error) {
            logger.error('Failed to load LLM configuration:', error);
            this.globalPrompt = DEFAULT_GLOBAL_PROMPT;
        }
    }

    // Thin alias retained for the getGlobalPrompt() lazy-load callsite. Delegates
    // to loadConfiguration so there is one query / one default.
    async loadGlobalPrompt() {
        return this.loadConfiguration();
    }

    async getGlobalPrompt() {
        if (!this.globalPrompt) {
            await this.loadGlobalPrompt();
        }
        // If the DB value is missing/empty, fall back to the shared default so
        // chat and MovieBot always have a usable global prompt.
        return this.globalPrompt || DEFAULT_GLOBAL_PROMPT;
    }

    async buildMovieSystemPrompt(basePrompt, personality, botUsername) {
        return promptBuilders.buildMovieSystemPrompt(basePrompt, personality, botUsername);
    }

    async buildSystemPrompt(basePrompt, personality, botUsername) {
        return promptBuilders.buildSystemPrompt(basePrompt, personality, botUsername, () => this.getGlobalPrompt());
    }

    buildMovieUserPrompt(transcriptPrompt, context, botUsername) {
        return promptBuilders.buildMovieUserPrompt(transcriptPrompt, context, botUsername);
    }

    buildUserPrompt(context, botUsername) {
        return promptBuilders.buildUserPrompt(context, botUsername);
    }

    cleanResponse(message) {
        // Remove quotes if the bot wrapped its response in them
        message = message.replace(/^["']|["']$/g, '');

        // Remove roleplay actions like *smiles* or (laughs)
        message = message.replace(/\*[^*]+\*/g, '');
        message = message.replace(/\([^)]+\)/g, '');

        // Remove "As a..." prefixes
        message = message.replace(/^As a[^,]+,\s*/i, '');

        // Trim whitespace
        message = message.trim();

        return message;
    }

    getFallbackResponse(context) {
        // If no context, generate a conversation starter
        if (context.length === 0) {
            const starters = [
                "Hey everyone! What's going on?",
                "Anyone watching anything good?",
                "How's everyone doing today?",
                "What's up chat?",
                "Hey! First time here!",
                "This stream looks interesting!",
                "Hi everyone!",
                "Anyone else just get here?",
                "What are we watching?",
                "Is this live?"
            ];
            return starters[Math.floor(Math.random() * starters.length)];
        }

        // Otherwise return a contextual response
        const lastMessage = context[context.length - 1];
        if (lastMessage) {
            // Check for questions
            if (lastMessage.message.includes('?')) {
                const questionResponses = [
                    "Good question!",
                    "I'm not sure actually",
                    "That's a tough one",
                    "Hmm, let me think...",
                    "I wonder that too",
                    "No idea lol"
                ];
                return questionResponses[Math.floor(Math.random() * questionResponses.length)];
            }

            // Check for greetings
            if (lastMessage.message.toLowerCase().match(/\b(hi|hey|hello|sup|yo)\b/)) {
                return `Hey ${lastMessage.username}!`;
            }
        }

        // Default fallback
        return this.fallbackResponses[Math.floor(Math.random() * this.fallbackResponses.length)];
    }

    async isModelAvailable(modelName) {
        return this.ollamaQueue.isModelAvailable(modelName);
    }

    async testConnection() {
        await this.checkAvailability();
        return this.isAvailable;
    }

    getAvailableModels() {
        return this.availableModels;
    }

    getCurrentModel() {
        return {
            name: this.model,
            info: this.availableModels.find(m => m.name === this.model) || {
                name: this.model,
                displayName: this.model,
                size: 'Unknown',
                description: 'Custom model'
            }
        };
    }

    async switchModel(newModel) {
        try {
            logger.debug(`🤖 LLM: Switching from ${this.model} to ${newModel}`);

            // Update the database
            await database.runAsync(
                'UPDATE chatbot_config SET llm_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                [newModel]
            );

            // Update the instance
            this.model = newModel;

            // Re-check availability with the new model
            await this.checkAvailability();

            logger.debug(`🤖 LLM: Model switched to ${newModel}, available: ${this.isAvailable}`);

            return {
                success: true,
                model: newModel,
                available: this.isAvailable
            };
        } catch (error) {
            logger.error('Error switching model:', error);
            throw error;
        }
    }

    // Get statistics about current model usage
    getStats() {
        const stats = {
            activeRequests: {},
            queueLength: this.ollamaQueue.requestQueue.length,
            cacheSize: this.modelCache.size,
            models: []
        };

        for (const [model, count] of this.activeRequests.entries()) {
            if (count > 0) {
                stats.activeRequests[model] = count;
            }
        }

        for (const [model, cache] of this.modelCache.entries()) {
            stats.models.push({
                name: model,
                available: cache.available,
                cacheAge: Date.now() - cache.lastChecked
            });
        }

        return stats;
    }

    // Groq API methods
    enableGroq(apiKey = null) {
        return groqConfigStore.enableGroq(this, database, logger, apiKey);
    }

    disableGroq() {
        return groqConfigStore.disableGroq(this, database, logger);
    }

    updateGroqSettings(enabled, apiKey = null, model = null) {
        return groqConfigStore.updateGroqSettings(this, database, logger, enabled, apiKey, model);
    }

    getGroqStatus() {
        return groqConfigStore.getGroqStatus(this);
    }

    async callGroqAPI(systemPrompt, userPrompt) {
        return this.groqClient.callGroqAPI(systemPrompt, userPrompt);
    }

    // Call Groq API with a specific model override (for character generation with larger models)
    async callGroqAPIWithModel(systemPrompt, userPrompt, modelOverride, maxTokens = 400, temperature = 0.95) {
        return this.groqClient.callGroqAPIWithModel(systemPrompt, userPrompt, modelOverride, maxTokens, temperature);
    }

    // Groq vision call. OpenAI-compatible image_url content-part shape.
    async callGroqAPIWithImage(opts) {
        return this.groqClient.callGroqAPIWithImage(opts);
    }

    // High-level wrapper used by VisionBotService — delegates to the Groq client.
    async generateVisionComment(opts) {
        return this.groqClient.generateVisionComment(opts);
    }
}

module.exports = ChatBotLLMService;
module.exports.GroqRateLimitError = GroqRateLimitError;
module.exports.GroqUnavailableError = GroqUnavailableError;
