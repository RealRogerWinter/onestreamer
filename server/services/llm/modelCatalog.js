/**
 * Static LLM model catalog + fallback responses — extracted verbatim from the
 * ChatBotLLMService constructor. Pure data (no `this`, no logic). The service
 * assigns these onto instance fields (this.groqModels / this.availableModels /
 * this.fallbackResponses) so all existing readers are unchanged.
 */

const GROQ_MODELS = [
            {
                id: 'llama-3.3-70b-versatile',
                name: 'Llama 3.3 70B Versatile',
                contextWindow: 32768,
                description: 'Most capable model, best for complex tasks',
                speed: 'Fast'
            },
            {
                id: 'llama-3.1-70b-versatile',
                name: 'Llama 3.1 70B Versatile',
                contextWindow: 32768,
                description: 'Highly capable, great balance of speed and quality',
                speed: 'Fast'
            },
            {
                id: 'llama-3.1-8b-instant',
                name: 'Llama 3.1 8B Instant',
                contextWindow: 128000,
                description: 'Ultra-fast responses, good for chat',
                speed: 'Ultra-Fast'
            },
            {
                id: 'llama3-70b-8192',
                name: 'Llama 3 70B',
                contextWindow: 8192,
                description: 'Previous gen large model',
                speed: 'Fast'
            },
            {
                id: 'llama3-8b-8192',
                name: 'Llama 3 8B',
                contextWindow: 8192,
                description: 'Previous gen small model',
                speed: 'Very Fast'
            },
            {
                id: 'mixtral-8x7b-32768',
                name: 'Mixtral 8x7B',
                contextWindow: 32768,
                description: 'MoE model, good for diverse tasks',
                speed: 'Fast'
            },
            {
                id: 'gemma2-9b-it',
                name: 'Gemma 2 9B',
                contextWindow: 8192,
                description: 'Google model, good for instructions',
                speed: 'Very Fast'
            },
            {
                id: 'gemma-7b-it',
                name: 'Gemma 7B',
                contextWindow: 8192,
                description: 'Google model, balanced performance',
                speed: 'Very Fast'
            }
        ];

const OLLAMA_MODELS = [
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

const FALLBACK_RESPONSES = [
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

module.exports = { GROQ_MODELS, OLLAMA_MODELS, FALLBACK_RESPONSES };
