class ProfanityFilterService {
    constructor() {
        // Basic profanity word list - expandable
        this.badWords = [
            // Racial slurs
            'nigger', 'nigga', 'chink', 'gook', 'spic', 'wetback', 'kike', 'kyke',
            'beaner', 'coon', 'jigaboo', 'raghead', 'towelhead', 'sand nigger',
            
            // Sexual/vulgar terms
            'fuck', 'shit', 'bitch', 'cunt', 'cock', 'dick', 'pussy', 'asshole',
            'faggot', 'fag', 'dyke', 'whore', 'slut', 'bastard', 'piss', 'cum',
            'jizz', 'penis', 'vagina', 'dildo', 'vibrator', 'anal', 'rape',
            
            // Variations and leetspeak
            'f4ck', 'fuk', 'fvck', 'sh1t', 'b1tch', 'a55', '@ss', 'd1ck',
            'p3nis', 'v4gina', 'r4pe', 'f@g', 'n1gger', 'n1gga',
            
            // Other offensive terms
            'retard', 'retarded', 'nazi', 'hitler', 'autism', 'autistic',
            'cancer', 'aids', 'kill yourself', 'kys', 'kms'
        ];
        
        // Create regex patterns for each bad word
        this.patterns = this.compilePatterns();
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
        
        // Check against patterns
        for (const pattern of this.patterns) {
            if (pattern.test(lowerText)) {
                console.log(`🚫 Profanity detected: ${pattern}`);
                return false;
            }
        }
        
        // Check for attempts to bypass filter with spaces/special chars
        const noSpaces = lowerText.replace(/[\s\-_.]/g, '');
        for (const word of this.badWords) {
            if (noSpaces.includes(word.replace(/\s/g, ''))) {
                console.log(`🚫 Profanity detected (bypass attempt): ${word}`);
                return false;
            }
        }
        
        // Check for zalgo text or excessive special characters
        const specialCharRatio = (text.match(/[^\w\s]/g) || []).length / text.length;
        if (specialCharRatio > 0.3) {
            console.log(`🚫 Excessive special characters detected`);
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