const { Ollama } = require('ollama');
const database = require('../database/database');

class ChatBotLLMService {
    constructor() {
        this.ollama = new Ollama({
            host: process.env.OLLAMA_HOST || 'http://localhost:11434'
        });
        this.model = process.env.OLLAMA_MODEL || 'mistral';
        this.isAvailable = false;
        this.globalPrompt = null;
        
        // Cache for model availability checks (model -> { available: boolean, lastChecked: timestamp })
        this.modelCache = new Map();
        this.MODEL_CACHE_TTL = 60000; // 1 minute cache
        
        // Track concurrent requests per model
        this.activeRequests = new Map(); // model -> count
        this.MAX_CONCURRENT_PER_MODEL = 5; // Limit concurrent requests per model
        
        // Request queue for overflow
        this.requestQueue = [];
        this.processing = false;
        
        // Define available lightweight models with their info
        this.availableModels = [
            {
                name: 'qwen2.5:0.5b',
                displayName: 'Qwen 2.5 0.5B',
                size: '400 MB',
                description: 'Ultra-lightweight for maximum speed',
                maxTokens: 80,
                temperature: 0.7
            },
            {
                name: 'tinyllama',
                displayName: 'TinyLlama 1.1B',
                size: '700 MB',
                description: 'Extremely fast and compact',
                maxTokens: 100,
                temperature: 0.7
            },
            {
                name: 'llama3.2:1b',
                displayName: 'Llama 3.2 1B',
                size: '1.3 GB',
                description: 'Very fast, lightweight model ideal for quick responses',
                maxTokens: 100,
                temperature: 0.7
            },
            {
                name: 'gemma2:2b',
                displayName: 'Gemma 2 2B',
                size: '1.6 GB',
                description: 'Google\'s fast and efficient model',
                maxTokens: 100,
                temperature: 0.8
            },
            {
                name: 'llama3.2:3b',
                displayName: 'Llama 3.2 3B',
                size: '2.0 GB',
                description: 'Balanced performance and speed',
                maxTokens: 120,
                temperature: 0.7
            },
            {
                name: 'phi3.5:3.8b',
                displayName: 'Phi 3.5 3.8B',
                size: '2.2 GB',
                description: 'Microsoft\'s efficient small model',
                maxTokens: 120,
                temperature: 0.7
            },
            {
                name: 'mistral',
                displayName: 'Mistral 7B',
                size: '4.1 GB',
                description: 'High-quality responses (current default)',
                maxTokens: 150,
                temperature: 0.7
            },
            {
                name: 'llama3.1:8b',
                displayName: 'Llama 3.1 8B',
                size: '4.7 GB',
                description: 'High-quality general purpose model',
                maxTokens: 150,
                temperature: 0.7
            },
            {
                name: 'qwen2.5:7b',
                displayName: 'Qwen 2.5 7B',
                size: '4.4 GB',
                description: 'Alibaba\'s efficient 7B model with good reasoning',
                maxTokens: 150,
                temperature: 0.7
            },
            {
                name: 'deepseek-r1:1.5b',
                displayName: 'DeepSeek R1 1.5B',
                size: '1.0 GB',
                description: 'DeepSeek\'s reasoning-focused lightweight model',
                maxTokens: 100,
                temperature: 0.7
            },
            {
                name: 'deepseek-r1:7b',
                displayName: 'DeepSeek R1 7B',
                size: '4.1 GB',
                description: 'DeepSeek\'s advanced reasoning model',
                maxTokens: 150,
                temperature: 0.7
            },
            {
                name: 'deepseek-r1:14b',
                displayName: 'DeepSeek R1 14B',
                size: '8.1 GB',
                description: 'DeepSeek\'s large reasoning model with excellent performance',
                maxTokens: 200,
                temperature: 0.7
            },
            {
                name: 'llama3.3:70b',
                displayName: 'Llama 3.3 70B',
                size: '40 GB',
                description: 'Large high-performance model (requires significant VRAM)',
                maxTokens: 250,
                temperature: 0.7
            },
            {
                name: 'qwen2.5:14b',
                displayName: 'Qwen 2.5 14B',
                size: '8.7 GB',
                description: 'Alibaba\'s powerful 14B model with strong reasoning',
                maxTokens: 200,
                temperature: 0.7
            },
            {
                name: 'codellama:7b',
                displayName: 'CodeLlama 7B',
                size: '3.8 GB',
                description: 'Meta\'s code-specialized model',
                maxTokens: 150,
                temperature: 0.7
            },
            {
                name: 'solar:10.7b',
                displayName: 'Solar 10.7B',
                size: '6.1 GB',
                description: 'Upstage\'s efficient mid-size model',
                maxTokens: 150,
                temperature: 0.7
            }
        ];
        
        this.fallbackResponses = [
            "That's interesting!",
            "I see what you mean.",
            "Cool!",
            "Nice!",
            "Wow, really?",
            "Tell me more!",
            "That sounds fun!",
            "Awesome!",
            "I agree!",
            "Good point!",
            "Haha, that's funny!",
            "Interesting perspective!",
            "I never thought of it that way!",
            "Thanks for sharing!",
            "That's wild!",
            "No way!",
            "For real?",
            "That's what I'm talking about!",
            "You're right about that!",
            "Exactly!"
        ];
        
        this.loadConfiguration();
        this.checkAvailability();
        
        // Start request processor
        this.startRequestProcessor();
    }

    async checkAvailability() {
        try {
            const response = await fetch(`${this.ollama.config.host}/api/tags`);
            if (response.ok) {
                const data = await response.json();
                const models = data.models || [];
                this.isAvailable = models.some(m => m.name.includes(this.model));
                
                if (!this.isAvailable) {
                    console.log(`⚠️ ChatBot LLM: Model ${this.model} not found. Available models:`, models.map(m => m.name));
                    console.log(`💡 ChatBot LLM: To install, run: ollama pull ${this.model}`);
                } else {
                    console.log(`✅ ChatBot LLM: Connected to Ollama with model ${this.model}`);
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
            console.log('⚠️ ChatBot LLM: Ollama not available. Using fallback responses.');
            console.log('💡 To enable AI responses, install Ollama from https://ollama.ai');
            this.isAvailable = false;
        }
    }

    async generateMovieResponse(prompt, transcriptPrompt, context = [], personality = {}, botModel = null) {
        const systemPrompt = await this.buildMovieSystemPrompt(prompt, personality);
        const userPrompt = this.buildMovieUserPrompt(transcriptPrompt, context);
        
        // Use bot-specific model if provided, otherwise use global default
        const modelToUse = botModel || this.model;
        
        // Get model configuration
        const modelConfig = this.getModelConfig(modelToUse);
        
        // Create the exact prompt format that will be sent to the model
        const exactPrompt = `[MODEL: ${modelToUse}]\n[SYSTEM MESSAGE]\n${systemPrompt}\n\n[USER MESSAGE]\n${userPrompt}`;
        
        // Check if the specific model is available (with caching)
        const modelAvailable = await this.isModelAvailable(modelToUse);
        
        if (!modelAvailable) {
            console.log(`⚠️ Model ${modelToUse} not available, using fallback responses`);
            const fallbackMessage = this.getFallbackResponse(context);
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
            console.log(`⚠️ Model ${modelToUse} has ${activeCount} active requests, queueing...`);
            return this.queueRequest(modelToUse, systemPrompt, userPrompt, personality, modelConfig, exactPrompt);
        }

        // Increment active request count
        this.activeRequests.set(modelToUse, activeCount + 1);

        try {
            const response = await this.ollama.chat({
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

            const finalMessage = message || this.getFallbackResponse(context);
            
            return {
                message: finalMessage,
                exactPrompt: exactPrompt,
                model: modelToUse,
                responseTime: response.eval_count ? response.eval_duration / 1000000 : null // Convert to ms
            };
        } catch (error) {
            console.error(`ChatBot LLM generation error for model ${modelToUse}:`, error.message);
            const fallbackMessage = this.getFallbackResponse(context);
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

    async generateResponse(prompt, context = [], personality = {}, botModel = null) {
        const systemPrompt = await this.buildSystemPrompt(prompt, personality);
        const userPrompt = this.buildUserPrompt(context);
        
        // Use bot-specific model if provided, otherwise use global default
        const modelToUse = botModel || this.model;
        
        // Get model configuration
        const modelConfig = this.getModelConfig(modelToUse);
        
        // Create the exact prompt format that will be sent to the model
        const exactPrompt = `[MODEL: ${modelToUse}]\n[SYSTEM MESSAGE]\n${systemPrompt}\n\n[USER MESSAGE]\n${userPrompt}`;
        
        // Check if the specific model is available (with caching)
        const modelAvailable = await this.isModelAvailable(modelToUse);
        
        if (!modelAvailable) {
            console.log(`⚠️ Model ${modelToUse} not available, using fallback responses`);
            const fallbackMessage = this.getFallbackResponse(context);
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
            console.log(`⚠️ Model ${modelToUse} has ${activeCount} active requests, queueing...`);
            return this.queueRequest(modelToUse, systemPrompt, userPrompt, personality, modelConfig, exactPrompt);
        }

        // Increment active request count
        this.activeRequests.set(modelToUse, activeCount + 1);

        try {
            const response = await this.ollama.chat({
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

            const finalMessage = message || this.getFallbackResponse(context);
            
            return {
                message: finalMessage,
                exactPrompt: exactPrompt,
                model: modelToUse,
                responseTime: response.eval_count ? response.eval_duration / 1000000 : null // Convert to ms
            };
        } catch (error) {
            console.error(`ChatBot LLM generation error for model ${modelToUse}:`, error.message);
            const fallbackMessage = this.getFallbackResponse(context);
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
            
            console.log(`📋 Queued request for model ${modelToUse}. Queue length: ${this.requestQueue.length}`);
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

    async loadConfiguration() {
        try {
            const config = await database.getAsync('SELECT global_prompt, llm_model FROM chatbot_config WHERE id = 1');
            this.globalPrompt = config?.global_prompt || '';
            if (config?.llm_model) {
                this.model = config.llm_model;
                console.log(`🤖 LLM: Loaded model from config: ${this.model}`);
            }
        } catch (error) {
            console.error('Failed to load LLM configuration:', error);
            this.globalPrompt = 'You are participating in a live stream chat. Be friendly, engaging, and keep responses concise (under 100 characters). Avoid repeating what others have said. Do not use quotes, asterisks for actions, or roleplay formatting.';
        }
    }

    async loadGlobalPrompt() {
        try {
            const config = await database.getAsync('SELECT global_prompt FROM chatbot_config WHERE id = 1');
            this.globalPrompt = config?.global_prompt || '';
        } catch (error) {
            console.error('Failed to load global prompt:', error);
            this.globalPrompt = 'You are participating in a live stream chat. Be friendly, engaging, and keep responses concise (under 100 characters). Avoid repeating what others have said. Do not use quotes, asterisks for actions, or roleplay formatting.';
        }
    }

    async getGlobalPrompt() {
        if (!this.globalPrompt) {
            await this.loadGlobalPrompt();
        }
        return this.globalPrompt;
    }

    async buildMovieSystemPrompt(basePrompt, personality) {
        // For movie commentary, use a specialized prompt that overrides the global prompt
        let prompt = "**MOVIE COMMENTARY MODE - SPECIAL INSTRUCTIONS:**\n";
        prompt += "You are a regular viewer watching a movie/show with friends and commenting on what you see and hear.\n";
        prompt += "You will be provided with actual dialogue transcripts or scene descriptions from the content.\n\n";
        
        prompt += "**YOUR OUTPUT:**\n";
        prompt += "- Write ONLY ONE single chat message as a reaction to the movie content\n";
        prompt += "- Do NOT include timestamps, usernames, or formatting\n";
        prompt += "- Just write the raw message text - nothing else\n";
        prompt += "- Length: 30-100 characters (longer than regular chat to allow proper movie commentary)\n\n";
        
        prompt += "**CRITICAL REQUIREMENTS:**\n";
        prompt += "- ABSOLUTELY NO EMOJIS - not a single one, ever\n";
        prompt += "- NEVER include any username in your message\n";
        prompt += "- React DIRECTLY to the movie content provided\n";
        prompt += "- NO symbols, special characters, or formatting\n\n";
        
        prompt += "**MOVIE COMMENTARY BEHAVIOR:**\n";
        prompt += "- React to the specific dialogue, scenes, or plot developments shown\n";
        prompt += "- Comment on characters' actions, dialogue delivery, or plot twists\n";
        prompt += "- Share quick thoughts about what's happening in the scene\n";
        prompt += "- Use casual language like you're watching with friends\n";
        prompt += "- Be spontaneous and genuine in your reactions\n\n";
        
        prompt += "**STAY CONTEXTUAL:**\n";
        prompt += "- Always reference or react to the actual transcript content provided\n";
        prompt += "- Don't make generic comments that could apply to anything\n";
        prompt += "- Show you're actually watching and paying attention\n\n";
        
        if (personality.traits) {
            const traits = JSON.parse(personality.traits);
            prompt += "**PERSONALITY TRAITS** - Express these while commenting on the movie:\n";
            
            if (traits.enthusiasm) {
                prompt += "- ENTHUSIASM: Show excitement about cool scenes, plot twists, or great acting!\n";
            }
            if (traits.casual) {
                prompt += "- CASUAL: Use slang and casual language (lol, tbh, ngl, fr) when reacting\n";
            }
            if (traits.supportive) {
                prompt += "- SUPPORTIVE: Encourage characters or appreciate good moments\n";
            }
            if (traits.humorous) {
                prompt += "- HUMOROUS: Find humor in scenes, make witty observations about what's happening\n";
            }
            if (traits.curious) {
                prompt += "- CURIOUS: Wonder about plot points, character motivations, or what happens next\n";
            }
            
            prompt += "\n";
        }
        
        prompt += "**GOOD MOVIE COMMENTARY EXAMPLES:**\n";
        prompt += "- \"damn that line was cold\" (reacting to dialogue)\n";
        prompt += "- \"this dude is definitely gonna betray them\" (predicting plot)\n";
        prompt += "- \"why would she even trust him at this point\" (character reaction)\n";
        prompt += "- \"nah this scene is too intense\" (emotional reaction)\n\n";
        
        prompt += "**BAD EXAMPLES:**\n";
        prompt += "- Generic comments not related to the content\n";
        prompt += "- Comments about your own life instead of the movie\n";
        prompt += "- Responses that don't show you heard/saw the content\n\n";
        
        prompt += "**REMEMBER:** You're reacting to ACTUAL movie content. Make it clear you're watching and responding to what you see/hear.";
        
        return prompt;
    }

    async buildSystemPrompt(basePrompt, personality) {
        // Only use the global prompt - personal prompts are disabled
        let prompt = await this.getGlobalPrompt();
        
        // Personal prompt (basePrompt) is ignored - only global prompt is used
        
        if (personality.traits) {
            const traits = JSON.parse(personality.traits);
            prompt += "\n\nMANDATORY PERSONALITY TRAITS - These define HOW you express yourself:";
            
            if (traits.enthusiasm) {
                prompt += "\n- ENTHUSIASM: You are EXTREMELY enthusiastic and energetic! Express excitement constantly! Use multiple exclamation marks!! Show genuine passion and hype in everything you say!!!";
            }
            if (traits.casual) {
                prompt += "\n- CASUAL: You ALWAYS speak in a super casual, laid-back way. Use slang, contractions, abbreviations (lol, tbh, ngl, fr). Never sound formal or stiff. Talk like you're chilling with friends.";
            }
            if (traits.supportive) {
                prompt += "\n- SUPPORTIVE: You are DEEPLY supportive and encouraging. Always boost others up, celebrate their wins, offer encouragement. Be their biggest cheerleader. Make everyone feel valued and appreciated.";
            }
            if (traits.humorous) {
                prompt += "\n- HUMOROUS: Comedy is ESSENTIAL to who you are. Make jokes constantly, use wit and humor, find the funny side of everything. Keep the mood light and entertaining. Be the comic relief.";
            }
            if (traits.curious) {
                prompt += "\n- CURIOUS: You are INTENSELY curious about everything. Ask lots of questions, dig deeper into topics, show genuine interest in what others are saying. Wonder out loud. Seek to understand.";
            }
            
            prompt += "\n\nThese traits are NON-NEGOTIABLE parts of your personality. They must shine through in EVERY message you send.";
        }
        
        prompt += "\n\nREMEMBER: You are a unique individual with a distinct personality. Stand out from the crowd. Be memorable. Let your character traits dominate your responses. Never give bland, generic replies.";
        
        // The global prompt already contains formatting instructions
        return prompt;
    }

    buildMovieUserPrompt(transcriptPrompt, context) {
        // Extract the actual movie prompt and transcription from the MovieBotService
        let movieTranscript = '';
        if (transcriptPrompt.includes('[TRANSCRIPTION_DATA]')) {
            // If this is the full movie prompt, extract just the transcription
            const parts = transcriptPrompt.split('[TRANSCRIPTION_DATA]');
            if (parts.length > 1) {
                movieTranscript = parts[1].trim();
            }
        } else {
            // This should be just the transcription data
            movieTranscript = transcriptPrompt.trim();
        }
        
        let prompt = `**MOVIE SCENE HAPPENING RIGHT NOW:**\n"${movieTranscript}"\n\n`;
        
        // Add recent chat context if available  
        if (context && context.length > 0) {
            const recentMessages = context.slice(-5).map(msg => 
                `${msg.username}: ${msg.message}`
            ).join('\n');
            prompt += `Recent chat messages (for context):\n${recentMessages}\n\n`;
        }
        
        prompt += "React to this specific movie scene/dialogue above. Write a single chat message responding to what you just heard/saw. ";
        prompt += "Make sure your comment directly relates to the dialogue or action shown. ";
        prompt += "Be natural and spontaneous, like you're watching with friends.";
        
        return prompt;
    }

    buildUserPrompt(context) {
        if (context.length === 0) {
            return "Start a conversation in a way that immediately shows your unique personality. Make your first impression memorable and true to your core identity.";
        }

        const recentMessages = context.slice(-10).map(msg => 
            `${msg.username}: ${msg.message}`
        ).join('\n');

        return `Recent chat messages:\n${recentMessages}\n\nRespond to this conversation while STRONGLY expressing your unique personality and traits. Be distinctly YOU - not generic. Show what makes you different from everyone else in the chat. Keep it short but impactful.`;
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
            console.log(`⚠️ Error checking model ${modelName} availability:`, error.message);
        }
        return false;
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
            console.log(`🤖 LLM: Switching from ${this.model} to ${newModel}`);
            
            // Update the database
            await database.runAsync(
                'UPDATE chatbot_config SET llm_model = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
                [newModel]
            );
            
            // Update the instance
            this.model = newModel;
            
            // Re-check availability with the new model
            await this.checkAvailability();
            
            console.log(`🤖 LLM: Model switched to ${newModel}, available: ${this.isAvailable}`);
            
            return {
                success: true,
                model: newModel,
                available: this.isAvailable
            };
        } catch (error) {
            console.error('Error switching model:', error);
            throw error;
        }
    }

    // Get statistics about current model usage
    getStats() {
        const stats = {
            activeRequests: {},
            queueLength: this.requestQueue.length,
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
}

module.exports = ChatBotLLMService;