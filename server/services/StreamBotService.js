const EventEmitter = require('events');
const https = require('https');
const axios = require('axios');

const logger = require('../bootstrap/logger').child({ svc: 'StreamBotService' });
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

        // Diverse username inspiration sources - vastly expanded for creativity
        this.usernameCategories = [
            // Classic internet patterns
            'first name + birth year (mike_92, sarah2001, jenny_87, chris_03)',
            'adjective + animal (quietwolf, lazypanda, silentbear, happycat)',
            'hobby + numbers (gamer2847, bookworm42, musiclover99, artsy_kid)',
            // Cultural/regional flavors
            'K-pop/anime fan style (bts_army_forever, sakura_chan22, oppa_fan, senpai_noticed)',
            'Spanish/Latin style (corazon_loco, el_gamer, chica_bonita99, amigo_del_sol)',
            'British slang style (proper_lad, cheeky_nando, bruv_moment, gobsmacked_gary)',
            'Australian style (g_day_mate, straya_steve, drop_bear_dan, no_wukkas)',
            // Generational patterns
            'zoomer style (no_cap_kelly, lowkey_vibing, its_giving_mike, slay_queen_23)',
            'millennial style (adulting_is_hard, avocado_toast_tim, i_cant_even, big_mood_mary)',
            'elder internet (AOL_steve_99, netscape_nancy, dial_up_dan, yahoo_yolanda)',
            // Occupation/life stage hints
            'night owl (3am_thoughts, insomnia_ian, late_shift_larry, cant_sleep_sam)',
            'parent life (tired_dad_47, wine_mom_life, snack_dealer_sara, carpool_carl)',
            'student vibes (finals_week_frank, ramen_budget_rick, dorm_life_diana)',
            'office worker (excel_ella, meetings_mike, coffee_IV_needed, reply_all_regret)',
            // Personality-revealing
            'self-aware/ironic (definitelynotabot, sendhelp_pls, idk_anymore, this_was_taken)',
            'confident (literally_the_best, main_character_energy, flawless_frank)',
            'anxious/relatable (overthinking_oliver, panic_at_the_chat, stress_sweater_sue)',
            'laid back (whatever_works, chill_pill_phil, no_drama_derek, goes_with_flow)',
            // Hobby-specific deep cuts
            'gamer specific (lag_is_real, console_peasant, kb_m_master, touch_grass_never)',
            'music nerd (vinyl_only_vic, bass_dropped_bob, playlist_curator_pat)',
            'sports fan (fantasy_league_fred, bench_warmer_bill, ref_was_blind)',
            'foodie (michelin_mouth_mark, hot_sauce_helen, picky_eater_pete)',
            // Aesthetic/vibe usernames
            'cottagecore (frog_on_a_log, mushroom_maiden, cozy_knitter)',
            'dark academia (dead_poets_dan, library_ghost, coffee_and_virgil)',
            'Y2K revival (glitter_gel_pen, butterfly_clips_betty, mp3_player_mary)',
            'chaos goblin (unhinged_ursula, chaos_carol, feral_frank)',
            // Location hints
            'city pride (brooklyn_bob, midwest_mark, socal_steve, texas_toast_tim)',
            'weather-based (rainy_seattle_sam, desert_dweller_dan, snow_day_sue)',
            // Absurdist/surreal
            'random objects (lamp_enthusiast, spoon_theory_sam, chair_connoisseur)',
            'food combos (pizza_pineapple_paul, ranch_on_everything, ketchup_on_eggs)',
            'animal crossing style (isabelle_stan, nook_miles_nancy, turnip_trader)',
            // Meme-influenced
            'current meme format (ohio_final_boss, skibidi_skeptic, sigma_grindset_sam)',
            'vintage meme (ermahgerd_earl, doge_fan_dave, overly_attached_omar)',
            // Number-heavy patterns
            'all numbers style (user847291, anon_2847, guest_9182)',
            'leetspeak adjacent (h4x0r_harry, n00b_nancy, pr0_gamer)',
            // Emotional state
            'permanently tired (need_coffee_now, running_on_fumes, zombie_mode_zack)',
            'chaotic neutral (here_for_drama, popcorn_ready, watching_chaos)',
            'wholesome (hug_dealer, good_vibes_gina, sunshine_steve)'
        ];

        // Moods that affect how the character engages with chat
        this.characterMoods = [
            'excited and cant contain it', 'mildly annoyed but trying to be nice',
            'extremely chill almost sleepy', 'nervously enthusiastic', 'smugly confident',
            'pleasantly confused', 'aggressively positive', 'quietly judging everyone',
            'suspiciously interested', 'performatively bored', 'genuinely delighted',
            'sarcastically engaged', 'mysteriously knowing', 'chaotically invested',
            'peacefully content', 'dramatically affected', 'casually unbothered',
            'intensely focused', 'whimsically distracted', 'grumpily endeared',
            'cautiously optimistic', 'recklessly enthusiastic', 'serenely unimpressed',
            'gleefully chaotic', 'stoically amused', 'warmly skeptical'
        ];

        // Strong opinions characters might hold
        this.characterOpinions = [
            'thinks this stream is underrated and tells everyone',
            'believes pineapple on pizza is a war crime',
            'insists cats are superior to dogs (will die on this hill)',
            'thinks modern music peaked in 2012',
            'believes everyone should drink more water',
            'is convinced theyre witnessing history right now',
            'thinks early morning is the only correct time to be awake',
            'believes snacks should be their own food group',
            'insists subtitles should always be on',
            'thinks phones have too many cameras now',
            'believes naps are a human right',
            'is passionate about proper grammar usage',
            'thinks dark mode should be mandatory everywhere',
            'believes the book is always better than the movie',
            'insists cereal is soup and will not be convinced otherwise',
            'thinks everyone is sleeping on this content',
            'believes hot take culture has gone too far (ironic)',
            'is convinced astrology explains everything',
            'thinks retro games hit different than modern ones',
            'believes in eating dessert first',
            'insists all meetings could be emails',
            'thinks autocorrect is a government conspiracy',
            'believes rain sounds are the ultimate background noise',
            'is passionate about the oxford comma'
        ];

        // Quirks and biases that make characters unique
        this.characterQuirks = [
            'always mentions what theyre currently snacking on',
            'uses way too many emotes in their messages',
            'types in all lowercase for aesthetic',
            'RANDOMLY capitalizes WORDS for emphasis',
            'always asks follow-up questions',
            'relates everything back to their pet',
            'makes obscure references nobody gets',
            'thinks out loud in chat',
            'always playing devils advocate',
            'cant help but give unsolicited advice',
            'remembers details from hours ago',
            'gets weirdly competitive about random things',
            'always has a relevant story',
            'asks the most obvious questions sincerely',
            'treats chat like a group therapy session',
            'responds to rhetorical questions literally',
            'always late to conversations but jumps in anyway',
            'keeps accidentally revealing too much about themselves',
            'treats every message like a dramatic reveal',
            'uses outdated slang unironically',
            'always has to one-up stories',
            'gets distracted mid-message and switches topics',
            'acts like everyone should know their inside jokes',
            'writes messages like tweets with character limits'
        ];
    }

    async initialize() {
        if (this.isInitialized) return;

        logger.debug('🤖 Initializing StreamBot Service...');

        // Start the periodic message system
        await this.startPeriodicMessages();

        // Start the auto-summon bot system
        await this.startAutoSummon();

        this.isInitialized = true;
        logger.debug('✅ StreamBot Service initialized');
    }

    // Service setters for dependency injection
    setChatBotService(chatBotService) {
        this.chatBotService = chatBotService;
        logger.debug('🤖 StreamBot: ChatBotService reference set');
    }

    setChatBotLLMService(chatBotLLMService) {
        this.chatBotLLMService = chatBotLLMService;
        logger.debug('🤖 StreamBot: ChatBotLLMService reference set');
    }

    async startPeriodicMessages() {
        // Clear any existing interval
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }

        // Get settings
        const settings = await this.getSettings();
        
        if (!settings || !settings.enabled) {
            logger.debug('🤖 StreamBot periodic messages are disabled');
            return;
        }

        logger.debug(`🤖 Starting StreamBot periodic messages (interval: ${settings.interval_minutes} minutes)`);
        
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

    // Lifecycle entry point — uniform name across services for the
    // bootstrap shutdown loop (PR 1.2). Stops both periodic-message and
    // auto-summon loops.
    async stop() {
        await this.stopPeriodicMessages();
        await this.stopAutoSummon();
    }

    async stopPeriodicMessages() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.debug('🤖 StreamBot periodic messages stopped');
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
                logger.debug('📨 StreamBot message sent to chat service successfully');
            }
        } catch (error) {
            logger.error('❌ Failed to send StreamBot message to chat:', error.message);
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
                logger.debug('🤖 No enabled StreamBot messages to send');
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
            
            logger.debug(`🤖 StreamBot sent message ${currentIndex + 1}/${messages.length}: "${message.message.substring(0, 50)}..."`);

            // Update the index and last sent time
            const nextIndex = (currentIndex + 1) % messages.length;
            await this.updateSettings({
                current_message_index: nextIndex,
                last_sent_at: new Date().toISOString()
            });

        } catch (error) {
            logger.error('❌ Error sending StreamBot message:', error);
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
            logger.debug('🤖 StreamBot: Auto-summon is disabled');
            return;
        }

        const intervalMs = settings.interval_minutes * 60 * 1000;
        logger.debug(`🤖 StreamBot: Starting auto-summon system (interval: ${settings.interval_minutes} minutes)`);

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
            logger.debug(`🤖 StreamBot: Next auto-summon in ${remainingMinutes} minutes`);

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
        logger.debug('🤖 StreamBot: Auto-summon stopped');
    }

    async autoSummonBot() {
        try {
            const settings = await this.getAutoSummonSettings();
            if (!settings || !settings.enabled) {
                logger.debug('🤖 StreamBot: Auto-summon disabled, skipping');
                return;
            }

            // Check if services are available
            if (!this.chatBotService) {
                logger.error('❌ StreamBot: ChatBotService not available for auto-summon');
                return;
            }

            logger.debug('🎭 StreamBot: Generating character pair via Groq...');

            // Generate a pair of opposing characters using Groq
            const pair = await this.generateCharacterPair();
            if (!pair || !pair.positive || !pair.negative) {
                logger.error('❌ StreamBot: Failed to generate character pair');
                return;
            }

            logger.debug(`🎭 StreamBot: Generated pair - ${pair.positive.name} (positive) & ${pair.negative.name} (negative)`);

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

            logger.debug(`✅ StreamBot: Auto-summoned pair ${pair.positive.name} & ${pair.negative.name} successfully!`);

        } catch (error) {
            logger.error('❌ StreamBot: Error in auto-summon:', error);
        }
    }

    async generateWhimsicalCharacter() {
        try {
            // Check if LLM service is available with Groq
            if (!this.chatBotLLMService) {
                logger.debug('⚠️ StreamBot: LLM service not available, using fallback character');
                return this.generateFallbackCharacter();
            }

            const groqStatus = this.chatBotLLMService.getGroqStatus();
            if (!groqStatus.enabled || !groqStatus.hasApiKey) {
                logger.debug('⚠️ StreamBot: Groq not available, using fallback character');
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
                logger.error('❌ StreamBot: Empty response from Groq');
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
                logger.error('❌ StreamBot: Failed to parse Groq response:', result.message);
                return this.generateFallbackCharacter();
            }

            // Validate the response
            if (!character.name || !character.personality) {
                logger.error('❌ StreamBot: Invalid character structure from Groq');
                return this.generateFallbackCharacter();
            }

            // Truncate if too long
            character.name = character.name.substring(0, 25);
            character.personality = character.personality.substring(0, 200);
            character.generatedPrompt = generationPrompt;

            return character;

        } catch (error) {
            logger.error('❌ StreamBot: Error generating character via Groq:', error);
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

    // Fallback pairs for when Groq is unavailable - diverse personalities with contrasting energies
    generateFallbackPair() {
        const fallbackPairs = [
            {
                positive: { name: 'cozy_vibes_only', personality: 'Warmly enthusiastic. Types cozy encouragements. Believes in hot cocoa solutions. Currently mood: blessed.' },
                negative: { name: 'seen_better_tbh', personality: 'Chronically unimpressed millennial. "its fine i guess." Always tired. Secretly watching intently.' }
            },
            {
                positive: { name: 'caps_lock_carol', personality: 'EVERYTHING IS EXCITING. Uses emotes liberally. Your personal hype squad. LETS GOOOO energy.' },
                negative: { name: 'lowercase_larry', personality: 'types in all lowercase for the aesthetic. too cool to use caps. still here tho.' }
            },
            {
                positive: { name: 'wholesome_dan_42', personality: 'Genuinely nice dad energy. "Great job, kiddo!" Has snacks to share. Supportive of everything.' },
                negative: { name: 'actually_karen_lol', personality: 'Plays the villain but lovingly. "I have NOTES." Secretly invested. Sarcastic mom energy.' }
            },
            {
                positive: { name: 'coffee_run_rachel', personality: 'Perpetually caffeinated and chatty. Currently on 3rd coffee. Thinks everyone is doing amazing.' },
                negative: { name: 'decaf_derek', personality: 'Running on fumes. Gave up caffeine, regrets it. Every message sounds tired but present.' }
            },
            {
                positive: { name: 'first_timer_here', personality: 'Wide-eyed newbie energy. Asks obvious questions genuinely. Easily amazed. Types with exclamation!!' },
                negative: { name: 'veteran_since_09', personality: '"Oh I remember when..." Gatekeeps gently. Has opinions about the old days. Reluctantly adapts.' }
            },
            {
                positive: { name: 'dog_dad_steve', personality: 'Relates everything to his dog. Shares pet pics unsolicited. Pure golden retriever energy.' },
                negative: { name: 'cat_stan_nina', personality: 'Cat superiority complex. Judges silently. Only speaks to drop wisdom. Aloof but present.' }
            },
            {
                positive: { name: 'emoji_enthusiast', personality: 'Communicates 50% in emojis. Believes in good vibes. Probably uses sparkle emotes unironically.' },
                negative: { name: 'no_emoji_policy', personality: 'Refuses emojis on principle. Dry text only. Somehow still expressive. Old school chatter.' }
            },
            {
                positive: { name: 'snack_break_sam', personality: 'Always eating something. Shares what snack theyre on. Comfort creature. Easily pleased.' },
                negative: { name: 'intermittent_ian', personality: 'Currently fasting (mentions it). Grumpy about food content. Still engaged though. Hangry undertones.' }
            },
            {
                positive: { name: 'early_bird_emma', personality: 'Up at 5am by choice. Aggressively morning person. Perky beyond reason. "rise and grind!"' },
                negative: { name: 'night_shift_nick', personality: '3am energy at all hours. Questionable sleep schedule. Philosophical at weird times.' }
            },
            {
                positive: { name: 'chaos_goblin_01', personality: 'Thrives in mayhem. "this is fine" as things escalate. Finds everything hilarious. Agent of chaos.' },
                negative: { name: 'needs_order_nancy', personality: 'Tries to organize chat. Slightly stressed by chaos. Makes lists. "can we focus please?"' }
            },
            {
                positive: { name: 'plant_parent_pat', personality: 'Owns too many plants. Treats them like children. Gentle soul. Easily emotional about nature.' },
                negative: { name: 'brown_thumb_brad', personality: 'Has killed every plant ever. Suspicious of plant content. "how do they survive." Resigned acceptance.' }
            },
            {
                positive: { name: 'nostalgia_nerd', personality: '"Remember when..." but positively. Collects happy memories. Rose tinted glasses but sweet.' },
                negative: { name: 'moving_on_mike', personality: '"Thats the past." Future focused to a fault. Impatient with callbacks. Lives in the now.' }
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
                logger.debug('⚠️ StreamBot: LLM service not available, using fallback pair');
                return this.generateFallbackPair();
            }

            const groqStatus = this.chatBotLLMService.getGroqStatus();
            if (!groqStatus.enabled || !groqStatus.hasApiKey) {
                logger.debug('⚠️ StreamBot: Groq not available, using fallback pair');
                return this.generateFallbackPair();
            }

            // Select random elements for variety - pick 2-3 of each for diversity
            const opposingPair = this.opposingPairs[Math.floor(Math.random() * this.opposingPairs.length)];

            // Pick 3 random username style inspirations
            const shuffledCategories = [...this.usernameCategories].sort(() => Math.random() - 0.5);
            const usernameStyles = shuffledCategories.slice(0, 3).join('\n- ');

            // Pick random moods for each character
            const positiveMood = this.characterMoods[Math.floor(Math.random() * this.characterMoods.length)];
            const negativeMood = this.characterMoods[Math.floor(Math.random() * this.characterMoods.length)];

            // Pick random opinions
            const opinion1 = this.characterOpinions[Math.floor(Math.random() * this.characterOpinions.length)];
            const opinion2 = this.characterOpinions[Math.floor(Math.random() * this.characterOpinions.length)];

            // Pick random quirks
            const quirk1 = this.characterQuirks[Math.floor(Math.random() * this.characterQuirks.length)];
            const quirk2 = this.characterQuirks[Math.floor(Math.random() * this.characterQuirks.length)];

            // Generate a unique seed to encourage variety
            const uniqueSeed = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

            const generationPrompt = `CREATE TWO UNIQUE STREAM CHATTERS [Seed: ${uniqueSeed}]

You're inventing TWO completely original chat personas who contrast with each other. Make them feel like REAL internet users with distinct personalities, NOT generic chatbot templates.

═══ CORE CONTRAST ═══
Character 1 vibe: ${opposingPair.positive}
Character 2 vibe: ${opposingPair.negative}

═══ USERNAME INSPIRATION (pick ONE style, invent a FRESH name) ═══
- ${usernameStyles}

IMPORTANT: Create BRAND NEW usernames. Do NOT use: mike_92, sarah2001, lazypanda, bookworm42, sunny_day, shadow99, or ANY example usernames. Invent something original that fits the style.

═══ MAKE THEM REAL ═══
Character 1:
- Current mood: ${positiveMood}
- Has this opinion: ${opinion1}
- Quirk: ${quirk1}

Character 2:
- Current mood: ${negativeMood}
- Has this opinion: ${opinion2}
- Quirk: ${quirk2}

═══ OUTPUT FORMAT ═══
Create a CONCISE personality prompt for each (max 120 chars). This prompt will instruct a small AI to roleplay as them, so include:
- Their core vibe/energy
- Their current mood
- One specific opinion or quirk
- How they type (casual, caps, lowercase, emotes, etc.)

Respond ONLY with valid JSON:
{"positive": {"name": "unique_username", "personality": "concise prompt for AI"}, "negative": {"name": "unique_username2", "personality": "concise prompt for AI"}}`;

            const systemPrompt = `You are a creative character designer who invents unique, realistic internet personas.
Each character must feel like a real person with genuine quirks, not a generic bot.
Never repeat usernames you've used before. Every name should be fresh and creative.
Respond only with valid JSON, no markdown.`;

            // Use the larger, more capable model for character generation
            const result = await this.chatBotLLMService.callGroqAPIWithModel(
                systemPrompt,
                generationPrompt,
                'llama-3.3-70b-versatile',
                500,
                0.95 // High temperature for creativity
            );

            if (!result || !result.message) {
                logger.error('❌ StreamBot: Empty response from Groq for pair');
                return this.generateFallbackPair();
            }

            logger.debug(`🎭 StreamBot: Generated characters using ${result.model}`);

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
                logger.error('❌ StreamBot: Failed to parse Groq pair response:', result.message);
                return this.generateFallbackPair();
            }

            // Validate the response
            if (!pair.positive || !pair.negative || !pair.positive.name || !pair.negative.name) {
                logger.error('❌ StreamBot: Invalid pair structure from Groq');
                return this.generateFallbackPair();
            }

            // Truncate if too long
            pair.positive.name = pair.positive.name.substring(0, 25);
            pair.positive.personality = pair.positive.personality.substring(0, 200);
            pair.positive.generatedPrompt = generationPrompt;

            pair.negative.name = pair.negative.name.substring(0, 25);
            pair.negative.personality = pair.negative.personality.substring(0, 200);
            pair.negative.generatedPrompt = generationPrompt;

            logger.debug(`✨ StreamBot: Created contrasting pair - "${pair.positive.name}" vs "${pair.negative.name}"`);

            return pair;

        } catch (error) {
            logger.error('❌ StreamBot: Error generating character pair via Groq:', error);
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
        logger.debug('🎭 StreamBot: Manual auto-summon triggered');
        return await this.autoSummonBot();
    }
}

module.exports = StreamBotService;
