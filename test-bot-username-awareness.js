const ChatBotLLMService = require('./server/services/ChatBotLLMService');

async function testBotUsernameAwareness() {
    console.log('🤖 Testing Bot Username Awareness\n');
    
    const llmService = new ChatBotLLMService();
    
    // Test regular bot with username
    console.log('=== REGULAR BOT SYSTEM PROMPT WITH USERNAME ===');
    const regularSystemPrompt = await llmService.buildSystemPrompt(
        'You are a friendly chat bot',
        { traits: JSON.stringify({ casual: true }) },
        'CoolBot123'
    );
    console.log(regularSystemPrompt);
    console.log('\n');
    
    // Test user prompt with bot's own messages
    console.log('=== USER PROMPT WITH BOT\'S OWN MESSAGES ===');
    const context = [
        { username: 'User1', message: 'hello everyone!' },
        { username: 'CoolBot123', message: 'hey there!' },
        { username: 'User2', message: 'CoolBot123 how are you?' },
        { username: 'CoolBot123', message: 'doing great thanks!' },
        { username: 'User1', message: 'nice weather today' }
    ];
    
    const userPrompt = llmService.buildUserPrompt(context, 'CoolBot123');
    console.log(userPrompt);
    console.log('\n');
    
    // Test movie bot with username
    console.log('=== MOVIE BOT SYSTEM PROMPT WITH USERNAME ===');
    const movieSystemPrompt = await llmService.buildMovieSystemPrompt(
        'Movie commentator bot',
        {},
        'MovieFan99'
    );
    console.log(movieSystemPrompt.substring(0, 1500)); // First part only
    console.log('\n');
    
    // Test movie user prompt with bot's own messages
    console.log('=== MOVIE USER PROMPT WITH BOT\'S OWN MESSAGES ===');
    const movieContext = [
        { username: 'Viewer1', message: 'this scene is intense' },
        { username: 'MovieFan99', message: 'I knew he was the villain :monkas:' },
        { username: 'Viewer2', message: 'MovieFan99 called it!' }
    ];
    
    const movieUserPrompt = llmService.buildMovieUserPrompt(
        '[TRANSCRIPTION_DATA] Hero: "You betrayed us!" Villain: "It was always part of the plan."',
        movieContext,
        'MovieFan99'
    );
    console.log(movieUserPrompt);
    console.log('\n');
    
    // Check for key features
    console.log('=== FEATURE CHECKS ===');
    if (regularSystemPrompt.includes('Your username in the chat is: CoolBot123')) {
        console.log('✅ Regular bot knows its username');
    } else {
        console.log('❌ Regular bot username not found');
    }
    
    if (userPrompt.includes('CoolBot123 (YOU):')) {
        console.log('✅ Bot recognizes its own messages in context');
    } else {
        console.log('❌ Bot self-recognition not working');
    }
    
    if (regularSystemPrompt.includes('DO NOT reply again')) {
        console.log('✅ Duplicate reply prevention included');
    } else {
        console.log('❌ Duplicate reply prevention not found');
    }
    
    if (movieSystemPrompt.includes('Your username in the chat is: MovieFan99')) {
        console.log('✅ Movie bot knows its username');
    } else {
        console.log('❌ Movie bot username not found');
    }
    
    console.log('\n=== EXPECTED BEHAVIOR ===');
    console.log('1. Bots will now be aware of their own username');
    console.log('2. They can see their own messages marked as "(YOU)" in the context');
    console.log('3. They will avoid repeating themselves if they already replied');
    console.log('4. They can respond when users mention them by name');
    console.log('5. Movie bots also have this awareness during movie commentary');
}

testBotUsernameAwareness().catch(console.error);