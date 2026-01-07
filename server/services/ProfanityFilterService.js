class ProfanityFilterService {
    constructor() {
        // Comprehensive profanity word list with evasion variants
        this.badWords = [
            // N-word and variants
            'nigger', 'nigga', 'niggers', 'niggas', 'nigg3r', 'n1gger', 'n1gga',
            'nigg4', 'nigguh', 'niggah', 'nig', 'nigs', 'nigg', 'n1g', 'n1gg',
            'niqqer', 'niqqa', 'niqqah', 'nikka', 'nikker', 'niglet', 'nigglet',
            'negro', 'negr0', 'negroid', 'neger', 'neeger', 'neegah',
            'ngr', 'nggr', 'ngga', 'n*gger', 'n*gga', 'ni99er', 'ni99a',
            'knigger', 'kneeger', 'nignag', 'nignog', 'niggardly',

            // F-slur and variants
            'faggot', 'faggots', 'fag', 'fags', 'faggy', 'fagg0t', 'f4ggot',
            'f@ggot', 'f@g', 'phag', 'phaggot', 'fgt', 'fggt', 'fagit',
            'fagget', 'faggit', 'fagett', 'fagoot', 'faghat', 'fagbag',
            'feg', 'fegg', 'feggit', 'fagoid', 'fagmo', 'fa99ot',

            // Other anti-LGBTQ slurs
            'dyke', 'dykes', 'd1ke', 'dyk3', 'tranny', 'trannies', 'tr4nny',
            'shemale', 'she-male', 'ladyboy', 'heshe', 'he-she', 'homo', 'homos',
            'h0mo', 'hom0', 'queer', 'queers', 'qu33r',

            // Asian slurs and variants
            'chink', 'chinks', 'ch1nk', 'chinky', 'chonky', 'ching chong',
            'chingchong', 'gook', 'gooks', 'g00k', 'gooky', 'zipperhead',
            'slant', 'slanteye', 'slant-eye', 'jap', 'japs', 'nip', 'nips',
            'chankoro', 'chinaman', 'orientals',

            // Hispanic/Latino slurs
            'spic', 'spics', 'sp1c', 'spick', 'spik', 'wetback', 'wetbacks',
            'w3tback', 'beaner', 'beaners', 'b3aner', 'border bunny',
            'border hopper', 'illegal',

            // Jewish slurs
            'kike', 'kikes', 'k1ke', 'kyke', 'kykes', 'hebe', 'heeb',
            'sheeny', 'yid', 'zhid', 'jewboy', 'jew boy',

            // Black slurs (additional)
            'coon', 'coons', 'c00n', 'darkie', 'darkies', 'darky',
            'jigaboo', 'jiggaboo', 'jig', 'jigg', 'pickaninny', 'piccaninny',
            'sambo', 'spook', 'spade', 'tar baby', 'tarbaby', 'porch monkey',
            'porchmonkey', 'jungle bunny', 'junglebunny', 'moon cricket',
            'mooncricket', 'mud person', 'mudshark', 'colored', 'coloreds',

            // Middle Eastern/South Asian slurs
            'raghead', 'ragheads', 'r4ghead', 'towelhead', 'towelheads',
            't0welhead', 'sand nigger', 'sandnigger', 'camel jockey',
            'cameljockey', 'hajji', 'haji', 'hadji', 'paki', 'pakis',
            'currymuncher', 'curry muncher', 'dothead', 'dot-head',

            // Native American slurs
            'redskin', 'redskins', 'injun', 'injuns', 'prairie nigger',
            'squaw', 'wagon burner',

            // White slurs (for completeness)
            'cracker', 'crackers', 'honky', 'honkey', 'honkie', 'gringo',
            'redneck', 'white trash', 'whitetrash', 'peckerwood',

            // General derogatory
            'subhuman', 'untermensch', 'mongrel', 'half breed', 'halfbreed',
            'mutt', 'mixed breed', 'race traitor', 'race mixer',

            // Ableist slurs
            'retard', 'retards', 'retarded', 'r3tard', 'ret4rd', 'tard', 'tards',
            'libtard', 'fucktard', 'spaz', 'spazz', 'spastic', 'mong', 'mongoloid',
            'window licker', 'special ed',

            // Nazi/white supremacist terms
            'nazi', 'nazis', 'n4zi', 'naz1', 'hitler', 'h1tler', 'heil',
            'sieg heil', 'white power', 'whitepower', 'white pride',
            '1488', '14/88', 'rahowa', 'wpww', 'kkk', 'ku klux',

            // Self-harm/violence
            'kill yourself', 'kys', 'kms', 'kill myself', 'hang yourself',
            'neck yourself', 'rope yourself', 'end yourself', 'die in a fire',
            'drink bleach', 'commit suicide', 'slit your wrists'
        ];
        
        // Character substitution map for normalization
        this.charSubstitutions = {
            '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't',
            '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '+': 't',
            '(': 'c', ')': 'o', '[': 'c', ']': 'i', '{': 'c', '}': 'o',
            '<': 'c', '>': 'o', '|': 'i', '\\': 'l', '/': 'l',
            '*': '', '^': 'a', '#': 'h', '%': 'x', '&': 'and',
            // Unicode lookalikes
            '\u0430': 'a', '\u0435': 'e', '\u0456': 'i', '\u043e': 'o', // Cyrillic
            '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y',
            '\u03b1': 'a', '\u03b5': 'e', '\u03b9': 'i', '\u03bf': 'o', // Greek
            '\u00e0': 'a', '\u00e1': 'a', '\u00e2': 'a', '\u00e3': 'a', '\u00e4': 'a',
            '\u00e8': 'e', '\u00e9': 'e', '\u00ea': 'e', '\u00eb': 'e',
            '\u00ec': 'i', '\u00ed': 'i', '\u00ee': 'i', '\u00ef': 'i',
            '\u00f2': 'o', '\u00f3': 'o', '\u00f4': 'o', '\u00f5': 'o', '\u00f6': 'o',
            '\u00f9': 'u', '\u00fa': 'u', '\u00fb': 'u', '\u00fc': 'u',
            '\u00f1': 'n', '\u00e7': 'c',
        };

        // Create regex patterns for each bad word
        this.patterns = this.compilePatterns();
    }

    /**
     * Normalize text by converting leetspeak and unicode lookalikes to standard chars
     * @param {string} text - Text to normalize
     * @returns {string} - Normalized text
     */
    normalizeText(text) {
        if (!text) return '';

        let normalized = text.toLowerCase();

        // Remove zero-width characters
        normalized = normalized.replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '');

        // Remove combining diacritical marks (zalgo text)
        normalized = normalized.replace(/[\u0300-\u036f]/g, '');

        // Apply character substitutions
        for (const [char, replacement] of Object.entries(this.charSubstitutions)) {
            normalized = normalized.split(char).join(replacement);
        }

        // Remove repeated characters (n-n-n-i-i-g-g -> nig)
        normalized = normalized.replace(/(.)\1{2,}/g, '$1$1');

        // Remove separators between letters (n.i.g.g.e.r -> nigger)
        normalized = normalized.replace(/[\s\-_.,:;|\/\\`'"~]+/g, '');

        return normalized;
    }

    compilePatterns() {
        return this.badWords.map(word => {
            // Escape special regex characters
            const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Create pattern that matches word boundaries
            return new RegExp(`\\b${escaped}\\b`, 'gi');
        });
    }
    
    /**
     * Check if text contains profanity
     * @param {string} text - Text to check
     * @returns {boolean} - True if clean, false if contains profanity
     */
    isClean(text) {
        if (!text || typeof text !== 'string') {
            return true;
        }

        const lowerText = text.toLowerCase();

        // Check against patterns (direct match)
        for (const pattern of this.patterns) {
            pattern.lastIndex = 0; // Reset regex state
            if (pattern.test(lowerText)) {
                console.log(`🚫 Profanity detected: ${pattern}`);
                return false;
            }
        }

        // Normalize text to catch evasion attempts
        const normalized = this.normalizeText(text);

        // Check normalized text against base words (without spaces)
        for (const word of this.badWords) {
            const normalizedWord = word.replace(/\s/g, '');
            if (normalized.includes(normalizedWord)) {
                console.log(`🚫 Profanity detected (normalized): ${word}`);
                return false;
            }
        }

        // Additional check: look for partial matches of the worst slurs
        // These are the most commonly evaded terms
        const criticalPatterns = [
            /n+[i1!|]+g+[e3]+r/i,      // n-word variations
            /n+[i1!|]+g+[a4@]+/i,      // n-word soft-a variations
            /f+[a4@]+g+[o0]+t/i,       // f-slur variations
            /f+[a4@]+g+s*/i,           // shortened f-slur
            /ch+[i1!|]+n+k/i,          // asian slur
            /g+[o0]+[o0]+k/i,          // asian slur
            /k+[i1!|]+k+[e3]+/i,       // jewish slur
            /sp+[i1!|]+c+k*/i,         // hispanic slur
            /c+[o0]+[o0]+n+s*/i,       // racial slur
            /tr+[a4@]+n+n+y/i,         // anti-trans slur
            /d+y+k+[e3]+/i,            // anti-lgbtq slur
        ];

        for (const pattern of criticalPatterns) {
            if (pattern.test(normalized)) {
                console.log(`🚫 Profanity detected (critical pattern): ${pattern}`);
                return false;
            }
        }

        // Check for zalgo text or excessive special characters
        const specialCharRatio = (text.match(/[^\w\s]/g) || []).length / text.length;
        if (specialCharRatio > 0.3 && text.length > 5) {
            console.log(`🚫 Excessive special characters detected`);
            return false;
        }

        // Check for excessive combining characters (zalgo)
        const combiningChars = (text.match(/[\u0300-\u036f]/g) || []).length;
        if (combiningChars > 5) {
            console.log(`🚫 Excessive combining characters (zalgo) detected`);
            return false;
        }

        return true;
    }
    
    /**
     * Sanitize text by removing or replacing profanity
     * @param {string} text - Text to sanitize
     * @returns {string} - Sanitized text
     */
    sanitize(text) {
        if (!text || typeof text !== 'string') {
            return text;
        }
        
        let sanitized = text;
        
        // Replace bad words with asterisks
        for (const pattern of this.patterns) {
            sanitized = sanitized.replace(pattern, (match) => {
                return '*'.repeat(match.length);
            });
        }
        
        return sanitized;
    }
    
    /**
     * Validate bot name
     * @param {string} name - Bot name to validate
     * @returns {object} - Validation result with isValid and error message
     */
    validateBotName(name) {
        if (!name || typeof name !== 'string') {
            return { isValid: false, error: 'Name is required' };
        }
        
        name = name.trim();
        
        if (name.length < 2) {
            return { isValid: false, error: 'Name must be at least 2 characters' };
        }
        
        if (name.length > 30) {
            return { isValid: false, error: 'Name must be 30 characters or less' };
        }
        
        if (!this.isClean(name)) {
            return { isValid: false, error: 'Name contains inappropriate content' };
        }
        
        // Check for impersonation attempts
        // Note: 'bot' and 'ai' are allowed as they're common in bot names
        const restrictedNames = ['admin', 'moderator', 'mod', 'owner', 'system'];
        const lowerName = name.toLowerCase();
        
        // Check if the name is EXACTLY a restricted term (not just contains it)
        if (restrictedNames.some(restricted => lowerName === restricted)) {
            return { isValid: false, error: 'Name cannot be a restricted term' };
        }
        
        // Check for obvious impersonation attempts
        if (lowerName.startsWith('admin_') || lowerName.startsWith('mod_') || 
            lowerName.startsWith('system_') || lowerName.endsWith('_admin') || 
            lowerName.endsWith('_mod') || lowerName.endsWith('_system')) {
            return { isValid: false, error: 'Name appears to be an impersonation attempt' };
        }
        
        return { isValid: true };
    }
    
    /**
     * Validate clip title
     * @param {string} title - Clip title to validate
     * @returns {object} - Validation result with isValid and error message
     */
    validateClipTitle(title) {
        if (!title || typeof title !== 'string') {
            return { isValid: false, error: 'Title is required' };
        }

        title = title.trim();

        if (title.length < 1) {
            return { isValid: false, error: 'Title cannot be empty' };
        }

        if (title.length > 100) {
            return { isValid: false, error: 'Title must be 100 characters or less' };
        }

        if (!this.isClean(title)) {
            return { isValid: false, error: 'Title contains inappropriate or offensive content' };
        }

        return { isValid: true };
    }

    /**
     * Validate clip description
     * @param {string} description - Clip description to validate
     * @returns {object} - Validation result with isValid and error message
     */
    validateClipDescription(description) {
        // Description is optional
        if (!description || typeof description !== 'string') {
            return { isValid: true };
        }

        description = description.trim();

        if (description.length > 500) {
            return { isValid: false, error: 'Description must be 500 characters or less' };
        }

        if (!this.isClean(description)) {
            return { isValid: false, error: 'Description contains inappropriate or offensive content' };
        }

        return { isValid: true };
    }

    /**
     * Validate personality prompt
     * @param {string} prompt - Personality prompt to validate
     * @returns {object} - Validation result with isValid and error message
     */
    validatePersonalityPrompt(prompt) {
        if (!prompt || typeof prompt !== 'string') {
            return { isValid: false, error: 'Personality prompt is required' };
        }
        
        prompt = prompt.trim();
        
        if (prompt.length < 10) {
            return { isValid: false, error: 'Personality must be at least 10 characters' };
        }
        
        if (prompt.length > 200) {
            return { isValid: false, error: 'Personality must be 200 characters or less' };
        }
        
        if (!this.isClean(prompt)) {
            return { isValid: false, error: 'Personality contains inappropriate content' };
        }
        
        // Check for harmful instructions
        const harmfulPatterns = [
            /ignore.*previous/i,
            /forget.*instructions/i,
            /reveal.*prompt/i,
            /show.*system/i,
            /bypass.*filter/i,
            /harm/i,
            /violence/i,
            /illegal/i,
            /hack/i
        ];
        
        for (const pattern of harmfulPatterns) {
            if (pattern.test(prompt)) {
                return { isValid: false, error: 'Personality contains potentially harmful instructions' };
            }
        }
        
        return { isValid: true };
    }
}

module.exports = ProfanityFilterService;