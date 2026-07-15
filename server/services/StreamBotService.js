const EventEmitter = require('events');

const MessageStore = require('./streambot/MessageStore');
const PeriodicMessageScheduler = require('./streambot/PeriodicMessageScheduler');
const CharacterGenerator = require('./streambot/CharacterGenerator');
const AutoSummonManager = require('./streambot/AutoSummonManager');

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
        this.chatServiceUrl = require('../utils/chatServiceClient').chatServiceUrl();

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

        // Cohesive collaborators (state stays on this service via `owner` back-ref).
        this.messageStore = new MessageStore(this);
        this.periodicScheduler = new PeriodicMessageScheduler(this);
        this.characterGenerator = new CharacterGenerator(this);
        this.autoSummonManager = new AutoSummonManager(this);
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
        return this.periodicScheduler.startPeriodicMessages();
    }

    // Lifecycle entry point — uniform name across services for the
    // bootstrap shutdown loop (PR 1.2). Stops both periodic-message and
    // auto-summon loops.
    async stop() {
        await this.stopPeriodicMessages();
        await this.stopAutoSummon();
    }

    async stopPeriodicMessages() {
        return this.periodicScheduler.stopPeriodicMessages();
    }

    async sendToChatService(message) {
        return this.periodicScheduler.sendToChatService(message);
    }

    async sendNextMessage() {
        return this.periodicScheduler.sendNextMessage();
    }

    // Database methods
    async getSettings() {
        return this.messageStore.getSettings();
    }

    async updateSettings(updates) {
        return this.messageStore.updateSettings(updates);
    }

    async getMessages() {
        return this.messageStore.getMessages();
    }

    async getEnabledMessages() {
        return this.messageStore.getEnabledMessages();
    }

    async getMessage(id) {
        return this.messageStore.getMessage(id);
    }

    async createMessage(message, orderIndex = null) {
        return this.messageStore.createMessage(message, orderIndex);
    }

    async updateMessage(id, updates) {
        return this.messageStore.updateMessage(id, updates);
    }

    async deleteMessage(id) {
        return this.messageStore.deleteMessage(id);
    }

    async reorderMessages(messageIds) {
        return this.messageStore.reorderMessages(messageIds);
    }

    async toggleMessage(id) {
        return this.messageStore.toggleMessage(id);
    }

    // Settings management
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
        return this.autoSummonManager.startAutoSummon();
    }

    async stopAutoSummon() {
        return this.autoSummonManager.stopAutoSummon();
    }

    async autoSummonBot() {
        return this.autoSummonManager.autoSummonBot();
    }

    async generateWhimsicalCharacter() {
        return this.characterGenerator.generateWhimsicalCharacter();
    }

    generateFallbackCharacter() {
        return this.characterGenerator.generateFallbackCharacter();
    }

    generateFallbackPair() {
        return this.characterGenerator.generateFallbackPair();
    }

    async generateCharacterPair() {
        return this.characterGenerator.generateCharacterPair();
    }

    // Auto-summon database methods
    async getAutoSummonSettings() {
        return this.autoSummonManager.getAutoSummonSettings();
    }

    async updateAutoSummonSettings(updates) {
        return this.autoSummonManager.updateAutoSummonSettings(updates);
    }

    async toggleAutoSummon() {
        return this.autoSummonManager.toggleAutoSummon();
    }

    async logAutoSummonedBot(chatbotId, botName, personality, generatedPrompt) {
        return this.autoSummonManager.logAutoSummonedBot(chatbotId, botName, personality, generatedPrompt);
    }

    async getAutoSummonedBotHistory(limit = 20) {
        return this.autoSummonManager.getAutoSummonedBotHistory(limit);
    }

    async triggerManualAutoSummon() {
        return this.autoSummonManager.triggerManualAutoSummon();
    }
}

module.exports = StreamBotService;
