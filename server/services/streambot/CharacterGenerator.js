/**
 * CharacterGenerator.js - StreamBot character/pair generation extracted from
 * StreamBotService.
 *
 * Builds Groq prompts from the static archetype/mood/quirk tables that remain
 * on the service (owner.characterArchetypes, owner.opposingPairs, …), calls
 * owner.chatBotLLMService, and falls back to the deterministic rosters when
 * Groq is unavailable. Bodies moved verbatim (only `this.`→`owner.`).
 */

const logger = require('../../bootstrap/logger').child({ svc: 'StreamBotService' });

class CharacterGenerator {
    constructor(owner) {
        this.owner = owner;
    }

    async generateWhimsicalCharacter() {
        const owner = this.owner;
        try {
            // Check if LLM service is available with Groq
            if (!owner.chatBotLLMService) {
                logger.debug('⚠️ StreamBot: LLM service not available, using fallback character');
                return owner.generateFallbackCharacter();
            }

            const groqStatus = owner.chatBotLLMService.getGroqStatus();
            if (!groqStatus.enabled || !groqStatus.hasApiKey) {
                logger.debug('⚠️ StreamBot: Groq not available, using fallback character');
                return owner.generateFallbackCharacter();
            }

            // Pick random archetype and personality modifier for variety
            const archetype = owner.characterArchetypes[Math.floor(Math.random() * owner.characterArchetypes.length)];
            const modifier = owner.personalityModifiers[Math.floor(Math.random() * owner.personalityModifiers.length)];

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

            const result = await owner.chatBotLLMService.callGroqAPI(systemPrompt, generationPrompt);

            if (!result || !result.message) {
                logger.error('❌ StreamBot: Empty response from Groq');
                return owner.generateFallbackCharacter();
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
                return owner.generateFallbackCharacter();
            }

            // Validate the response
            if (!character.name || !character.personality) {
                logger.error('❌ StreamBot: Invalid character structure from Groq');
                return owner.generateFallbackCharacter();
            }

            // Truncate if too long
            character.name = character.name.substring(0, 25);
            character.personality = character.personality.substring(0, 200);
            character.generatedPrompt = generationPrompt;

            return character;

        } catch (error) {
            logger.error('❌ StreamBot: Error generating character via Groq:', error);
            return owner.generateFallbackCharacter();
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
        const owner = this.owner;
        try {
            // Check if LLM service is available with Groq
            if (!owner.chatBotLLMService) {
                logger.debug('⚠️ StreamBot: LLM service not available, using fallback pair');
                return owner.generateFallbackPair();
            }

            const groqStatus = owner.chatBotLLMService.getGroqStatus();
            if (!groqStatus.enabled || !groqStatus.hasApiKey) {
                logger.debug('⚠️ StreamBot: Groq not available, using fallback pair');
                return owner.generateFallbackPair();
            }

            // Select random elements for variety - pick 2-3 of each for diversity
            const opposingPair = owner.opposingPairs[Math.floor(Math.random() * owner.opposingPairs.length)];

            // Pick 3 random username style inspirations
            const shuffledCategories = [...owner.usernameCategories].sort(() => Math.random() - 0.5);
            const usernameStyles = shuffledCategories.slice(0, 3).join('\n- ');

            // Pick random moods for each character
            const positiveMood = owner.characterMoods[Math.floor(Math.random() * owner.characterMoods.length)];
            const negativeMood = owner.characterMoods[Math.floor(Math.random() * owner.characterMoods.length)];

            // Pick random opinions
            const opinion1 = owner.characterOpinions[Math.floor(Math.random() * owner.characterOpinions.length)];
            const opinion2 = owner.characterOpinions[Math.floor(Math.random() * owner.characterOpinions.length)];

            // Pick random quirks
            const quirk1 = owner.characterQuirks[Math.floor(Math.random() * owner.characterQuirks.length)];
            const quirk2 = owner.characterQuirks[Math.floor(Math.random() * owner.characterQuirks.length)];

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
            const result = await owner.chatBotLLMService.callGroqAPIWithModel(
                systemPrompt,
                generationPrompt,
                'llama-3.3-70b-versatile',
                500,
                0.95 // High temperature for creativity
            );

            if (!result || !result.message) {
                logger.error('❌ StreamBot: Empty response from Groq for pair');
                return owner.generateFallbackPair();
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
                return owner.generateFallbackPair();
            }

            // Validate the response
            if (!pair.positive || !pair.negative || !pair.positive.name || !pair.negative.name) {
                logger.error('❌ StreamBot: Invalid pair structure from Groq');
                return owner.generateFallbackPair();
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
            return owner.generateFallbackPair();
        }
    }
}

module.exports = CharacterGenerator;
