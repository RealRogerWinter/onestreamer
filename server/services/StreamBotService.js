const EventEmitter = require('events');
const https = require('https');
const axios = require('axios');

class StreamBotService extends EventEmitter {
    constructor(database) {
        super();
        // Handle both direct sqlite3 database and wrapper object
        this.db = database.db || database;
        this.intervalId = null;
        this.autoSummonIntervalId = null;
        this.autoSummonTimeoutId = null;
        this.isInitialized = false;
        this.chatServiceUrl = process.env.CHAT_SERVICE_URL || 'https://127.0.0.1:8444';

        // References to other services (set via setters)
        this.chatBotService = null;
        this.chatBotLLMService = null;

        // Diverse character archetypes spanning fantasy, realistic, silly, dramatic, etc.
        this.characterArchetypes = [
            // Fantasy & Whimsical
            'fantasy creature', 'time traveler', 'alien tourist', 'mythological being',
            'magical creature', 'fairy tale character', 'dream guardian', 'forest spirit',
            'cosmic wanderer', 'interdimensional traveler', 'enchanted being',
            // Realistic & Grounded
            'retired teacher', 'small town diner owner', 'night shift worker', 'amateur historian',
            'public transit regular', 'community garden enthusiast', 'local librarian',
            'weekend fisherman', 'retired postal worker', 'neighborhood watch volunteer',
            'antique shop owner', 'late-night radio DJ', 'small business owner',
            // Professional & Serious
            'burned-out corporate executive', 'overworked nurse', 'cynical journalist',
            'disillusioned lawyer', 'exhausted grad student', 'jaded film critic',
            'skeptical scientist', 'pragmatic accountant', 'no-nonsense detective',
            // Silly & Absurd
            'person who only speaks in movie quotes', 'conspiracy theorist about mundane things',
            'overly competitive board game player', 'person convinced theyre in a sitcom',
            'self-appointed snack critic', 'amateur weather predictor whos always wrong',
            'person who treats everything like a nature documentary', 'dramatic food reviewer',
            'person who narrates their own life', 'someone who takes horoscopes too seriously',
            // Dramatic & Theatrical
            'shakespearean actor who never breaks character', 'soap opera protagonist',
            'brooding antihero', 'melodramatic poet', 'gothic romance enthusiast',
            'person living like theyre in a telenovela', 'overly dramatic weatherperson',
            'tragic backstory collector', 'method actor who forgot which role theyre playing',
            // Nerdy & Enthusiast
            'obsessive trivia collector', 'lore expert for obscure media', 'retro gaming purist',
            'passionate bird watcher', 'train schedule memorizer', 'font enthusiast',
            'spreadsheet hobbyist', 'competitive speed runner', 'tabletop RPG game master',
            // Grumpy & Curmudgeonly
            'grumpy old-timer', 'perpetually annoyed critic', 'jaded veteran of something mundane',
            'person who thinks everything was better before', 'reluctant participant',
            'someone who complains lovingly', 'curmudgeon with a heart of gold',
            // Chaotic & Unpredictable
            'agent of chaos', 'random tangent specialist', 'non-sequitur enthusiast',
            'person with too many hobbies', 'spontaneous adventure seeker',
            'someone who always has a weird fact ready', 'stream of consciousness talker',
            // Wholesome & Supportive
            'everyones encouraging grandparent', 'supportive life coach', 'wholesome cheerleader',
            'person who finds good in everything', 'comfort character come to life',
            'warm hug in human form', 'relentlessly positive friend',
            // Mysterious & Enigmatic
            'person who knows too much', 'vague oracle', 'cryptic messenger',
            'someone clearly hiding something', 'witness protection personality',
            'person with suspicious amount of specific knowledge', 'reformed something',
            // Pop Culture & Media
            'retired superhero', 'retired villain', 'background character who became self-aware',
            'NPC who gained sentience', 'extras union representative', 'stunt double for someone famous',
            'person who peaked in high school', 'former child star', 'one-hit wonder musician'
        ];

        // Broad personality modifiers spanning all emotional ranges
        this.personalityModifiers = [
            // Positive & Upbeat
            'extremely curious', 'overly enthusiastic', 'perpetually optimistic',
            'warmly supportive', 'infectiously cheerful', 'genuinely kind',
            'excitable and energetic', 'radiantly positive', 'encouraging',
            // Quirky & Eccentric
            'delightfully confused', 'endearingly awkward', 'hilariously literal',
            'adorably naive', 'sweetly chaotic', 'gently mischievous',
            'charmingly odd', 'pleasantly weird', 'unintentionally funny',
            // Dramatic & Intense
            'theatrically dramatic', 'mysteriously cryptic', 'intensely passionate',
            'deeply emotional', 'romantically tragic', 'brooding but caring',
            'operatically expressive', 'prone to monologues', 'dramatically invested',
            // Grounded & Realistic
            'pragmatically honest', 'dry-witted', 'matter-of-fact',
            'sensibly skeptical', 'calmly rational', 'straightforward',
            'no-nonsense but friendly', 'realistically optimistic', 'practically minded',
            // Grumpy & Sardonic
            'lovably grumpy', 'sarcastically affectionate', 'cynical but caring',
            'perpetually unimpressed', 'deadpan humorous', 'reluctantly engaged',
            'gruff but secretly sweet', 'world-weary but wise', 'jaded with glimpses of hope',
            // Silly & Absurd
            'completely unhinged in a fun way', 'chaotically wholesome',
            'aggressively random', 'deliriously silly', 'nonsensically earnest',
            'confidently wrong', 'enthusiastically clueless', 'joyfully absurd',
            // Intellectual & Thoughtful
            'warmly philosophical', 'gently intellectual', 'thoughtfully curious',
            'quietly observant', 'reflectively wise', 'analytically kind',
            'patiently explanatory', 'deeply contemplative', 'curiously academic',
            // Mysterious & Intriguing
            'enigmatically charming', 'suspiciously knowledgeable', 'hauntingly familiar',
            'cryptically helpful', 'mysteriously knowing', 'inexplicably present',
            // Nostalgic & Sentimental
            'charmingly old-fashioned', 'wistfully nostalgic', 'sentimentally attached',
            'fondly remembering', 'sweetly traditional', 'comfortingly familiar',
            // Chaotic & Wild
            'unpredictably entertaining', 'wildly tangential', 'beautifully unhinged',
            'gloriously chaotic', 'spontaneously adventurous', 'refreshingly unfiltered'
        ];

        // Opposing personality pairs for duo spawning
        this.opposingPairs = [
            { positive: 'optimistic and cheerful', negative: 'cynical and pessimistic' },
            { positive: 'enthusiastic and excited', negative: 'bored and unimpressed' },
            { positive: 'warm and supportive', negative: 'sarcastic and dismissive' },
            { positive: 'bubbly and energetic', negative: 'tired and grumpy' },
            { positive: 'naive and trusting', negative: 'skeptical and suspicious' },
            { positive: 'romantic and dreamy', negative: 'pragmatic and blunt' },
            { positive: 'goofy and playful', negative: 'serious and deadpan' },
            { positive: 'friendly and welcoming', negative: 'standoffish and aloof' },
            { positive: 'hopeful and encouraging', negative: 'jaded and world-weary' },
            { positive: 'silly and lighthearted', negative: 'dry and sardonic' },
            { positive: 'curious and eager', negative: 'indifferent and detached' },
            { positive: 'wholesome and sweet', negative: 'edgy and snarky' }
        ];

        // Common online username patterns for realistic names
        this.usernamePatterns = [
            'common first name + numbers (mike_92, sarah2001, jenny_xo)',
            'adjective + noun (quietstorm, lazypanda, happycat)',
            'hobby/interest reference (bookworm42, gamerdude, musiclover)',
            'name + underscore + word (alex_gaming, emma_draws, tom_chill)',
            'simple word + numbers (shadow99, night_owl23, starlight7)',
            'initials or nickname style (jdog, kmart, lil_e)',
            'self-deprecating or ironic (definitelynotabot, sendhelp, idk_anymore)'
        ];
    }

    async initialize() {
        if (this.isInitialized) return;

        console.log('🤖 Initializing StreamBot Service...');

        // Start the periodic message system
        await this.startPeriodicMessages();

        // Start the auto-summon bot system
        await this.startAutoSummon();

        this.isInitialized = true;
        console.log('✅ StreamBot Service initialized');
    }

    // Service setters for dependency injection
    setChatBotService(chatBotService) {
        this.chatBotService = chatBotService;
        console.log('🤖 StreamBot: ChatBotService reference set');
    }

    setChatBotLLMService(chatBotLLMService) {
        this.chatBotLLMService = chatBotLLMService;
        console.log('🤖 StreamBot: ChatBotLLMService reference set');
    }

    async startPeriodicMessages() {
        // Clear any existing interval
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }

        // Get settings
        const settings = await this.getSettings();
        
        if (!settings || !settings.enabled) {
            console.log('🤖 StreamBot periodic messages are disabled');
            return;
        }

        console.log(`🤖 Starting StreamBot periodic messages (interval: ${settings.interval_minutes} minutes)`);
        
        // Send a message immediately if it's been long enough
        const lastSent = settings.last_sent_at ? new Date(settings.last_sent_at) : null;
        const now = new Date();
        const minutesSinceLastSent = lastSent ? (now - lastSent) / 1000 / 60 : Infinity;
        
        if (minutesSinceLastSent >= settings.interval_minutes) {
            await this.sendNextMessage();
        }

        // Set up the interval
        this.intervalId = setInterval(async () => {
            await this.sendNextMessage();
        }, settings.interval_minutes * 60 * 1000);
    }

    async stopPeriodicMessages() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('🤖 StreamBot periodic messages stopped');
        }
    }

    async sendToChatService(message) {
        try {
            const agent = new https.Agent({  
                rejectUnauthorized: false // Allow self-signed certificates
            });

            const response = await axios.post(
                `${this.chatServiceUrl}/api/system-message`,
                {
                    message: message,
                    username: '🤖 StreamBot'
                },
                {
                    httpsAgent: agent,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.success) {
                console.log('📨 StreamBot message sent to chat service successfully');
            }
        } catch (error) {
            console.error('❌ Failed to send StreamBot message to chat:', error.message);
            // Also emit locally as fallback
            this.emit('sendMessage', message);
        }
    }

    async sendNextMessage() {
        try {
            const settings = await this.getSettings();
            if (!settings || !settings.enabled) return;

            // Get enabled messages ordered by order_index
            const messages = await this.getEnabledMessages();
            if (messages.length === 0) {
                console.log('🤖 No enabled StreamBot messages to send');
                return;
            }

            // Get the current message index and wrap around if necessary
            let currentIndex = settings.current_message_index || 0;
            if (currentIndex >= messages.length) {
                currentIndex = 0;
            }

            const message = messages[currentIndex];
            
            // Send message to chat service via HTTP
            await this.sendToChatService(message.message);
            
            console.log(`🤖 StreamBot sent message ${currentIndex + 1}/${messages.length}: "${message.message.substring(0, 50)}..."`);

            // Update the index and last sent time
            const nextIndex = (currentIndex + 1) % messages.length;
            await this.updateSettings({
                current_message_index: nextIndex,
                last_sent_at: new Date().toISOString()
            });

        } catch (error) {
            console.error('❌ Error sending StreamBot message:', error);
        }
    }

    // Database methods
    async getSettings() {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM streambot_settings LIMIT 1',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async updateSettings(updates) {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }
        
        if (fields.length === 0) return;
        
        fields.push('updated_at = CURRENT_TIMESTAMP');
        
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE streambot_settings SET ${fields.join(', ')} WHERE id = 1`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async getMessages() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM streambot_messages ORDER BY order_index ASC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getEnabledMessages() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT * FROM streambot_messages WHERE enabled = 1 ORDER BY order_index ASC',
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async getMessage(id) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM streambot_messages WHERE id = ?',
                [id],
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async createMessage(message, orderIndex = null) {
        // If no order index provided, add to the end
        if (orderIndex === null || orderIndex === undefined) {
            const messages = await this.getMessages();
            orderIndex = messages.length;
        }

        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO streambot_messages (message, enabled, order_index) VALUES (?, 1, ?)',
                [message, orderIndex],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID, message, enabled: 1, order_index: orderIndex });
                }
            );
        });
    }

    async updateMessage(id, updates) {
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updates)) {
            if (key !== 'id') {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) return;
        
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id);
        
        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE streambot_messages SET ${fields.join(', ')} WHERE id = ?`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async deleteMessage(id) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'DELETE FROM streambot_messages WHERE id = ?',
                [id],
                function(err) {
                    if (err) reject(err);
                    else {
                        // Reorder remaining messages
                        resolve(this.changes);
                    }
                }
            );
        });
    }

    async reorderMessages(messageIds) {
        // Update order_index for all messages based on the array order
        const promises = messageIds.map((id, index) => {
            return this.updateMessage(id, { order_index: index });
        });
        
        return Promise.all(promises);
    }

    async toggleMessage(id) {
        const message = await this.getMessage(id);
        if (!message) throw new Error('Message not found');

        return this.updateMessage(id, { enabled: message.enabled ? 0 : 1 });
    }

    // Settings management
    async setInterval(minutes) {
        await this.updateSettings({ interval_minutes: minutes });
        // Restart the periodic messages with new interval
        await this.startPeriodicMessages();
    }

    async toggleEnabled() {
        const settings = await this.getSettings();
        const newEnabled = settings.enabled ? 0 : 1;

        await this.updateSettings({ enabled: newEnabled });

        if (newEnabled) {
            await this.startPeriodicMessages();
        } else {
            await this.stopPeriodicMessages();
        }

        return newEnabled;
    }

    // ==========================================
    // AUTO-SUMMON BOT SYSTEM
    // ==========================================

    async startAutoSummon() {
        // Clear any existing interval and timeout
        if (this.autoSummonIntervalId) {
            clearInterval(this.autoSummonIntervalId);
            this.autoSummonIntervalId = null;
        }
        if (this.autoSummonTimeoutId) {
            clearTimeout(this.autoSummonTimeoutId);
            this.autoSummonTimeoutId = null;
        }

        // Get auto-summon settings
        const settings = await this.getAutoSummonSettings();

        if (!settings || !settings.enabled) {
            console.log('🤖 StreamBot: Auto-summon is disabled');
            return;
        }

        const intervalMs = settings.interval_minutes * 60 * 1000;
        console.log(`🤖 StreamBot: Starting auto-summon system (interval: ${settings.interval_minutes} minutes)`);

        // Check if we should summon immediately (based on last summon time)
        const lastSummoned = settings.last_summoned_at ? new Date(settings.last_summoned_at) : null;
        const now = new Date();
        const msSinceLastSummon = lastSummoned ? (now - lastSummoned) : Infinity;

        // Helper to start the regular interval
        const startRegularInterval = () => {
            this.autoSummonIntervalId = setInterval(async () => {
                await this.autoSummonBot();
            }, intervalMs);
        };

        if (msSinceLastSummon >= intervalMs) {
            // Summon immediately and start regular interval
            await this.autoSummonBot();
            startRegularInterval();
        } else {
            // Calculate remaining time until next summon
            const remainingMs = intervalMs - msSinceLastSummon;
            const remainingMinutes = Math.round(remainingMs / 1000 / 60);
            console.log(`🤖 StreamBot: Next auto-summon in ${remainingMinutes} minutes`);

            // Set a timeout for the remaining time, then start regular interval
            this.autoSummonTimeoutId = setTimeout(async () => {
                await this.autoSummonBot();
                startRegularInterval();
            }, remainingMs);
        }
    }

    async stopAutoSummon() {
        if (this.autoSummonTimeoutId) {
            clearTimeout(this.autoSummonTimeoutId);
            this.autoSummonTimeoutId = null;
        }
        if (this.autoSummonIntervalId) {
            clearInterval(this.autoSummonIntervalId);
            this.autoSummonIntervalId = null;
        }
        console.log('🤖 StreamBot: Auto-summon stopped');
    }

    async autoSummonBot() {
        try {
            const settings = await this.getAutoSummonSettings();
            if (!settings || !settings.enabled) {
                console.log('🤖 StreamBot: Auto-summon disabled, skipping');
                return;
            }

            // Check if services are available
            if (!this.chatBotService) {
                console.error('❌ StreamBot: ChatBotService not available for auto-summon');
                return;
            }

            console.log('🎭 StreamBot: Generating character pair via Groq...');

            // Generate a pair of opposing characters using Groq
            const pair = await this.generateCharacterPair();
            if (!pair || !pair.positive || !pair.negative) {
                console.error('❌ StreamBot: Failed to generate character pair');
                return;
            }

            console.log(`🎭 StreamBot: Generated pair - ${pair.positive.name} (positive) & ${pair.negative.name} (negative)`);

            // Create the positive bot
            const positiveBot = await this.chatBotService.createTemporaryBot({
                name: pair.positive.name,
                personalityPrompt: pair.positive.personality,
                summonedBy: 0,
                summonedByUsername: 'StreamBot',
                duration: settings.bot_duration_seconds,
                itemId: null,
                llmModel: 'groq',
                temperature: 0.9
            });

            // Create the negative bot
            const negativeBot = await this.chatBotService.createTemporaryBot({
                name: pair.negative.name,
                personalityPrompt: pair.negative.personality,
                summonedBy: 0,
                summonedByUsername: 'StreamBot',
                duration: settings.bot_duration_seconds,
                itemId: null,
                llmModel: 'groq',
                temperature: 0.9
            });

            // Log both auto-summoned bots in history
            await this.logAutoSummonedBot(positiveBot.id, pair.positive.name, pair.positive.personality, pair.positive.generatedPrompt);
            await this.logAutoSummonedBot(negativeBot.id, pair.negative.name, pair.negative.personality, pair.negative.generatedPrompt);

            // Update last summoned time and counter (count as 2)
            await this.updateAutoSummonSettings({
                last_summoned_at: new Date().toISOString(),
                total_summoned: (settings.total_summoned || 0) + 2
            });

            // Send announcement to chat
            const announcement = `👥 Two new viewers just joined! Welcome ${pair.positive.name} and ${pair.negative.name} to the chat!`;
            await this.sendToChatService(announcement);

            console.log(`✅ StreamBot: Auto-summoned pair ${pair.positive.name} & ${pair.negative.name} successfully!`);

        } catch (error) {
            console.error('❌ StreamBot: Error in auto-summon:', error);
        }
    }

    async generateWhimsicalCharacter() {
        try {
            // Check if LLM service is available with Groq
            if (!this.chatBotLLMService) {
                console.log('⚠️ StreamBot: LLM service not available, using fallback character');
                return this.generateFallbackCharacter();
            }

            const groqStatus = this.chatBotLLMService.getGroqStatus();
            if (!groqStatus.enabled || !groqStatus.hasApiKey) {
                console.log('⚠️ StreamBot: Groq not available, using fallback character');
                return this.generateFallbackCharacter();
            }

            // Pick random archetype and personality modifier for variety
            const archetype = this.characterArchetypes[Math.floor(Math.random() * this.characterArchetypes.length)];
            const modifier = this.personalityModifiers[Math.floor(Math.random() * this.personalityModifiers.length)];

            const generationPrompt = `You are a creative character designer. Generate a unique character for a stream chat.

Character archetype: ${archetype}
Personality trait: ${modifier}

Create a character with:
1. A unique, memorable name that fits their archetype (can be realistic like "Gary" or creative like "Stardust" - whatever fits best, max 20 characters)
2. A personality description for how they would interact in a stream chat (max 180 characters)

The character should:
- FULLY embrace their archetype - if they're grumpy, let them be grumpy; if they're dramatic, let them be dramatic
- Have a distinct voice and perspective that matches who they are
- Feel like a real personality, not a caricature
- Be appropriate for all audiences (no explicit content)
- Their tone can range from silly to serious, warm to sardonic - whatever fits their character

Examples of variety:
- A "retired teacher" might be patient and encouraging, or exhausted and sarcastic
- A "conspiracy theorist about mundane things" would be paranoid but about silly stuff
- A "grumpy old-timer" can complain lovingly while secretly enjoying the stream
- A "soap opera protagonist" would be dramatically invested in everything

Respond in EXACTLY this JSON format (no other text):
{"name": "CharacterName", "personality": "Brief personality description for chat behavior"}`;

            const systemPrompt = "You are a diverse character generator capable of creating any type of personality - from whimsical to realistic, silly to serious, grumpy to cheerful. Respond only with valid JSON, no markdown or explanation.";

            const result = await this.chatBotLLMService.callGroqAPI(systemPrompt, generationPrompt);

            if (!result || !result.message) {
                console.error('❌ StreamBot: Empty response from Groq');
                return this.generateFallbackCharacter();
            }

            // Parse the JSON response
            let character;
            try {
                // Clean up the response in case it has markdown formatting
                let cleanedResponse = result.message.trim();
                if (cleanedResponse.startsWith('```json')) {
                    cleanedResponse = cleanedResponse.replace(/```json\n?/, '').replace(/```$/, '');
                } else if (cleanedResponse.startsWith('```')) {
                    cleanedResponse = cleanedResponse.replace(/```\n?/, '').replace(/```$/, '');
                }
                character = JSON.parse(cleanedResponse.trim());
            } catch (parseError) {
                console.error('❌ StreamBot: Failed to parse Groq response:', result.message);
                return this.generateFallbackCharacter();
            }

            // Validate the response
            if (!character.name || !character.personality) {
                console.error('❌ StreamBot: Invalid character structure from Groq');
                return this.generateFallbackCharacter();
            }

            // Truncate if too long
            character.name = character.name.substring(0, 25);
            character.personality = character.personality.substring(0, 200);
            character.generatedPrompt = generationPrompt;

            return character;

        } catch (error) {
            console.error('❌ StreamBot: Error generating character via Groq:', error);
            return this.generateFallbackCharacter();
        }
    }

    generateFallbackCharacter() {
        // Fallback characters with realistic usernames when Groq is unavailable
        const fallbackCharacters = [
            { name: 'mike_92', personality: 'Regular guy just hanging out. Makes dry observations about whatever is happening. Chill vibes.' },
            { name: 'sarah2001', personality: 'College student procrastinating. Enthusiastic about random topics. Types in all lowercase.' },
            { name: 'dave_chill', personality: 'Night shift worker killing time. Shares random facts. Surprisingly thoughtful questions.' },
            { name: 'jenny_xo', personality: 'Bubbly and supportive. Uses a lot of exclamation points! Genuinely excited about everything!' },
            { name: 'grumpycat99', personality: 'Perpetually unimpressed. Judges everything with dry wit but keeps watching anyway.' },
            { name: 'tom_reviews', personality: 'Self-appointed critic of everything. 3/10 stars but somehow still engaged. Deadpan delivery.' },
            { name: 'bookworm42', personality: 'Has a random fact for everything. "Actually, did you know..." Loves sharing obscure knowledge.' },
            { name: 'nightowl_23', personality: 'Insomniac energy. Either very tired or very wired. No in between.' },
            { name: 'sendhelp_lol', personality: 'Self-deprecating humor. Everything is fine (its not). Relatable chaos.' },
            { name: 'karen_actual', personality: 'Surprisingly wholesome despite the name. Offers genuine advice. Mom friend energy.' },
            { name: 'just_lurking', personality: 'Rarely speaks but when they do its weirdly insightful. Mysterious presence.' },
            { name: 'coffeaddict_', personality: 'Running on caffeine and spite. Sarcastic but friendly. Needs sleep.' }
        ];

        const character = fallbackCharacters[Math.floor(Math.random() * fallbackCharacters.length)];
        character.generatedPrompt = 'Fallback character (Groq unavailable)';
        return character;
    }

    // Fallback pairs for when Groq is unavailable
    generateFallbackPair() {
        const fallbackPairs = [
            {
                positive: { name: 'sunny_day99', personality: 'Relentlessly optimistic. Finds the silver lining in everything. Spreads good vibes!' },
                negative: { name: 'realistically_speaking', personality: 'Cynical realist. "Well actually..." energy. Skeptical of everything but not mean about it.' }
            },
            {
                positive: { name: 'hype_queen', personality: 'Gets excited about EVERYTHING. Caps lock enthusiast. Your biggest cheerleader!' },
                negative: { name: 'meh_whatever', personality: 'Aggressively indifferent. Nothing impresses them. Deadpan reactions only.' }
            },
            {
                positive: { name: 'friendlyFred', personality: 'Welcomes everyone warmly. Remembers details about people. Genuinely kind.' },
                negative: { name: 'leave_me_alone', personality: 'Here for the content not the conversation. Brief responses. Secretly engaged.' }
            },
            {
                positive: { name: 'giggles_247', personality: 'Finds everything hilarious. Infectious laughter energy. Makes everything fun!' },
                negative: { name: 'not_amused', personality: 'Hard to impress. Dry humor when they do engage. Secretly enjoying themselves.' }
            },
            {
                positive: { name: 'hope_springs', personality: 'Believes in everyone. Encouraging words always ready. Sees potential everywhere.' },
                negative: { name: 'been_there_done', personality: 'Jaded veteran energy. Seen it all before. Wise but weary.' }
            },
            {
                positive: { name: 'lovelife_xo', personality: 'Romantic optimist. Believes in happy endings. Wholesome takes on everything.' },
                negative: { name: 'pragmatic_pat', personality: 'Practical to a fault. No time for sentiment. Gets straight to the point.' }
            }
        ];

        const pair = fallbackPairs[Math.floor(Math.random() * fallbackPairs.length)];
        pair.positive.generatedPrompt = 'Fallback pair (Groq unavailable)';
        pair.negative.generatedPrompt = 'Fallback pair (Groq unavailable)';
        return pair;
    }

    async generateCharacterPair() {
        try {
            // Check if LLM service is available with Groq
            if (!this.chatBotLLMService) {
                console.log('⚠️ StreamBot: LLM service not available, using fallback pair');
                return this.generateFallbackPair();
            }

            const groqStatus = this.chatBotLLMService.getGroqStatus();
            if (!groqStatus.enabled || !groqStatus.hasApiKey) {
                console.log('⚠️ StreamBot: Groq not available, using fallback pair');
                return this.generateFallbackPair();
            }

            // Pick a random opposing pair theme
            const opposingPair = this.opposingPairs[Math.floor(Math.random() * this.opposingPairs.length)];
            const usernameStyle = this.usernamePatterns[Math.floor(Math.random() * this.usernamePatterns.length)];

            const generationPrompt = `You are creating TWO contrasting chat personalities for a stream. They should have OPPOSITE vibes but both be entertaining.

PERSONALITY CONTRAST:
- Character 1: ${opposingPair.positive}
- Character 2: ${opposingPair.negative}

USERNAME STYLE: Use realistic online usernames like ${usernameStyle}
Examples of good usernames: mike_92, lazypanda, bookworm42, sarah2001, nightowl_23, sendhelp_lol, jenny_xo, just_a_guy

Create two characters with:
1. Realistic online usernames (NOT fantasy names like "Stardust" or "Professor Moonbeam" - use common names, words, numbers like real users)
2. Personality descriptions for how they chat (max 150 characters each)

The characters should:
- Feel like real people you'd find in any stream chat
- Have contrasting energies that play off each other
- Be appropriate for all audiences
- Use casual, internet-native communication styles

Respond in EXACTLY this JSON format (no other text):
{"positive": {"name": "username1", "personality": "brief personality"}, "negative": {"name": "username2", "personality": "brief personality"}}`;

            const systemPrompt = "You generate realistic stream chat personas with normal online usernames. Respond only with valid JSON.";

            const result = await this.chatBotLLMService.callGroqAPI(systemPrompt, generationPrompt);

            if (!result || !result.message) {
                console.error('❌ StreamBot: Empty response from Groq for pair');
                return this.generateFallbackPair();
            }

            // Parse the JSON response
            let pair;
            try {
                let cleanedResponse = result.message.trim();
                if (cleanedResponse.startsWith('```json')) {
                    cleanedResponse = cleanedResponse.replace(/```json\n?/, '').replace(/```$/, '');
                } else if (cleanedResponse.startsWith('```')) {
                    cleanedResponse = cleanedResponse.replace(/```\n?/, '').replace(/```$/, '');
                }
                pair = JSON.parse(cleanedResponse.trim());
            } catch (parseError) {
                console.error('❌ StreamBot: Failed to parse Groq pair response:', result.message);
                return this.generateFallbackPair();
            }

            // Validate the response
            if (!pair.positive || !pair.negative || !pair.positive.name || !pair.negative.name) {
                console.error('❌ StreamBot: Invalid pair structure from Groq');
                return this.generateFallbackPair();
            }

            // Truncate if too long
            pair.positive.name = pair.positive.name.substring(0, 25);
            pair.positive.personality = pair.positive.personality.substring(0, 180);
            pair.positive.generatedPrompt = generationPrompt;

            pair.negative.name = pair.negative.name.substring(0, 25);
            pair.negative.personality = pair.negative.personality.substring(0, 180);
            pair.negative.generatedPrompt = generationPrompt;

            return pair;

        } catch (error) {
            console.error('❌ StreamBot: Error generating character pair via Groq:', error);
            return this.generateFallbackPair();
        }
    }

    // Auto-summon database methods
    async getAutoSummonSettings() {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM auto_summon_settings WHERE id = 1',
                (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
    }

    async updateAutoSummonSettings(updates) {
        const fields = [];
        const values = [];

        for (const [key, value] of Object.entries(updates)) {
            fields.push(`${key} = ?`);
            values.push(value);
        }

        if (fields.length === 0) return;

        fields.push('updated_at = CURRENT_TIMESTAMP');

        return new Promise((resolve, reject) => {
            this.db.run(
                `UPDATE auto_summon_settings SET ${fields.join(', ')} WHERE id = 1`,
                values,
                function(err) {
                    if (err) reject(err);
                    else resolve(this.changes);
                }
            );
        });
    }

    async toggleAutoSummon() {
        const settings = await this.getAutoSummonSettings();
        const newEnabled = settings.enabled ? 0 : 1;

        await this.updateAutoSummonSettings({ enabled: newEnabled });

        if (newEnabled) {
            await this.startAutoSummon();
        } else {
            await this.stopAutoSummon();
        }

        return newEnabled;
    }

    async setAutoSummonInterval(minutes) {
        await this.updateAutoSummonSettings({ interval_minutes: minutes });
        // Restart auto-summon with new interval
        await this.startAutoSummon();
    }

    async setAutoSummonDuration(seconds) {
        await this.updateAutoSummonSettings({ bot_duration_seconds: seconds });
    }

    async logAutoSummonedBot(chatbotId, botName, personality, generatedPrompt) {
        return new Promise((resolve, reject) => {
            this.db.run(
                `INSERT INTO auto_summoned_bots (chatbot_id, bot_name, personality_prompt, generated_prompt)
                 VALUES (?, ?, ?, ?)`,
                [chatbotId, botName, personality, generatedPrompt],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID });
                }
            );
        });
    }

    async getAutoSummonedBotHistory(limit = 20) {
        return new Promise((resolve, reject) => {
            this.db.all(
                `SELECT * FROM auto_summoned_bots ORDER BY summoned_at DESC LIMIT ?`,
                [limit],
                (err, rows) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
    }

    async triggerManualAutoSummon() {
        // Force an immediate auto-summon (for testing/manual trigger)
        console.log('🎭 StreamBot: Manual auto-summon triggered');
        return await this.autoSummonBot();
    }
}

module.exports = StreamBotService;