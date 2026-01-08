const ChatBotLLMService = require('./server/services/ChatBotLLMService');

async function showExamplePrompt() {
    const llmService = new ChatBotLLMService();
    
    // Wait a moment for service to initialize
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Example bot configuration from database
    const exampleBot = {
        prompt: "You are a sarcastic movie critic who loves action films but hates romantic comedies. You speak like a film noir detective from the 1940s.",
        personality_traits: JSON.stringify({
            enthusiasm: true,
            casual: true,
            humorous: true
        }),
        response_creativity_temperature: 0.8
    };
    
    const botUsername = "FilmNoir42";
    
    // Build the full system prompt
    const fullPrompt = await llmService.buildSystemPrompt(
        exampleBot.prompt,
        {
            traits: exampleBot.personality_traits,
            temperature: exampleBot.response_creativity_temperature
        },
        botUsername
    );
    
    console.log("=" * 80);
    console.log("FULL CHATBOT SYSTEM PROMPT:");
    console.log("=" * 80);
    console.log(fullPrompt);
    console.log("=" * 80);
    
    // Also show movie bot prompt
    const moviePrompt = await llmService.buildMovieSystemPrompt(
        exampleBot.prompt,
        {
            traits: exampleBot.personality_traits,
            temperature: exampleBot.response_creativity_temperature
        },
        botUsername
    );
    
    console.log("\n");
    console.log("=" * 80);
    console.log("FULL MOVIEBOT SYSTEM PROMPT:");
    console.log("=" * 80);
    console.log(moviePrompt);
    console.log("=" * 80);
    
    process.exit(0);
}

showExamplePrompt().catch(console.error);