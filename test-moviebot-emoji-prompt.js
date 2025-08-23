const ChatBotLLMService = require('./server/services/ChatBotLLMService');

async function testMovieBotEmojiPrompt() {
    console.log('🎬 Testing MovieBot Emoji Prompt Integration\n');
    
    const llmService = new ChatBotLLMService();
    
    // Test building the movie system prompt
    const systemPrompt = await llmService.buildMovieSystemPrompt('Test bot prompt', {});
    
    console.log('=== SYSTEM PROMPT ===');
    console.log(systemPrompt);
    console.log('\n');
    
    // Check if emoji instructions are included
    if (systemPrompt.includes('EMOJI USAGE:')) {
        console.log('✅ Emoji usage section found in prompt');
    } else {
        console.log('❌ Emoji usage section NOT found in prompt');
    }
    
    if (systemPrompt.includes(':kekw:') && systemPrompt.includes(':monkas:')) {
        console.log('✅ Specific emoji examples found in prompt');
    } else {
        console.log('❌ Specific emoji examples NOT found in prompt');
    }
    
    if (systemPrompt.includes('custom emojis sparingly')) {
        console.log('✅ Emoji frequency guidance found in prompt');
    } else {
        console.log('❌ Emoji frequency guidance NOT found in prompt');
    }
    
    // Test building the user prompt
    const userPrompt = llmService.buildMovieUserPrompt(
        '[TRANSCRIPTION_DATA] Character 1: "This is incredible!" Character 2: "I can\'t believe it worked!"',
        [
            { username: 'User1', message: 'wow amazing scene' },
            { username: 'User2', message: 'this is getting good :pog:' }
        ]
    );
    
    console.log('\n=== USER PROMPT ===');
    console.log(userPrompt);
    console.log('\n');
    
    // Simulate what a full prompt would look like
    console.log('=== EXPECTED BEHAVIOR ===');
    console.log('MovieBots should now be able to use custom emojis like:');
    console.log('- "That plot twist :monkas:"');
    console.log('- "Amazing acting :pog:"');
    console.log('- ":kekw: that was hilarious"');
    console.log('- "This is so sad :sadge:"');
    console.log('\nBut they should use them sparingly (0-1 per message usually)');
}

testMovieBotEmojiPrompt().catch(console.error);