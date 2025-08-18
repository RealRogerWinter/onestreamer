# 🤖 ChatBot Service Documentation

## Overview
The ChatBot Service simulates real users in the chat by leveraging lightweight LLMs to generate contextual responses. Bots appear as regular users with anonymous usernames in the format `[Animal][Number]`.

## Features

### Core Functionality
- **AI-Powered Responses**: Uses Ollama with lightweight models (Mistral, TinyLlama, etc.)
- **Fallback System**: Intelligent fallback responses when LLM is unavailable
- **Context Awareness**: Analyzes last 30 chat messages for relevant responses
- **Personality System**: Customizable traits (enthusiasm, casual, supportive, humorous, curious)
- **Scheduling**: Random response intervals per bot (configurable)
- **Persistence**: All bot configurations stored in SQLite database

### Admin Features
- Create unlimited chatbots with custom prompts
- Edit bot personalities and behaviors
- Enable/disable bots in real-time
- Test bot responses before deployment
- Monitor active bot sessions
- View message history per bot
- Toggle robot emoji visibility

## Setup

### 1. Install Ollama (Optional - for AI responses)
```bash
# Download from https://ollama.ai
# Then run:
ollama serve
ollama pull mistral  # or tinyllama, phi-2, qwen:0.5b
```

### 2. Configure Environment (Optional)
```bash
# .env file
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=mistral
CHAT_SERVICE_URL=http://localhost:3001
```

### 3. Start Services
```bash
# Quick start with all services
node start-with-chatbots.js

# Or manually:
cd chat-service && node index.js  # Port 3001
cd server && node index.js         # Port 8080  
cd client && npm start             # Port 3000
```

## Usage

### Creating a ChatBot

1. Open Admin Panel (http://localhost:3000)
2. Navigate to ChatBots tab
3. Click "Create New Bot"
4. Configure:
   - **Name**: Custom name or leave empty for random
   - **Prompt**: System prompt defining bot personality
   - **Response Interval**: Min/max seconds between messages
   - **Personality Traits**: Check applicable traits
   - **Temperature**: Creativity level (0.1-1.0)
   - **Robot Emoji**: Show 🤖 prefix in chat

### Prompt Templates

**Friendly Viewer**
```
You are a friendly and enthusiastic viewer who loves watching streams and chatting with others.
```

**Gaming Expert**
```
You are a knowledgeable gamer who loves discussing game strategies and sharing tips.
```

**Hype Person**
```
You are super enthusiastic and love hyping up the stream! You use lots of exclamation marks!
```

**Chill Lurker**
```
You are a relaxed viewer who occasionally chimes in with supportive comments.
```

## Architecture

### Components

```
ChatBotService (Core)
├── ChatBotLLMService (AI Integration)
│   ├── Ollama Client
│   ├── Response Generation
│   └── Fallback System
├── Database Layer
│   ├── chatbots table
│   ├── chatbot_sessions table
│   └── chatbot_message_history table
├── Socket.IO Clients
│   └── Per-bot connections to chat service
└── Scheduling System
    └── Random interval timers
```

### Database Schema

**chatbots**
- id, name, prompt, is_enabled
- response_interval_min/max
- show_robot_emoji, personality_traits

**chatbot_sessions**
- chatbot_id, socket_id, username, color
- connected_at, last_message_at

**chatbot_message_history**
- chatbot_id, message, context, created_at

## API Endpoints

```
GET    /api/chatbots          - List all bots
POST   /api/chatbots          - Create bot
PUT    /api/chatbots/:id      - Update bot
DELETE /api/chatbots/:id      - Delete bot
POST   /api/chatbots/:id/toggle - Enable/disable
POST   /api/chatbots/:id/test - Test response
GET    /api/chatbots/sessions - Active sessions
GET    /api/chatbots/:id/history - Message history
GET    /api/chatbots/llm-status - Check LLM availability
```

## Troubleshooting

### Bots not responding
1. Check LLM status in admin panel
2. Verify Ollama is running: `curl http://localhost:11434/api/tags`
3. Check chat service is running on port 3001
4. Ensure bot is enabled in admin panel

### Fallback responses only
- Install and run Ollama
- Pull a supported model: `ollama pull mistral`
- Restart the server

### Connection issues
- Verify chat service URL in environment
- Check firewall settings for ports 3001, 8080
- Review server logs for error messages

## Performance

### Recommended Models (by size)
- **Qwen:0.5b** - 350MB, fastest responses
- **TinyLlama** - 600MB, good balance
- **Phi-2** - 1.5GB, better quality
- **Mistral** - 4GB, best quality

### Resource Usage
- Each bot: ~5MB memory + socket connection
- LLM: Varies by model (350MB - 4GB)
- Response time: 200ms - 2s depending on model

## Security Considerations

- Bots only accessible through admin panel
- Authentication required for all bot operations
- Rate limiting on response generation
- Context limited to 30 messages
- No access to sensitive user data

## Testing

```bash
# Test ChatBot service
node test-chatbot-service.js

# Manual testing
1. Create bot in admin panel
2. Use "Test" button for sample response
3. Enable bot and monitor in chat
4. Check message history in admin panel
```

## Future Enhancements

- [ ] Multi-language support
- [ ] Voice synthesis integration
- [ ] Emotion detection and response
- [ ] Bot-to-bot conversations
- [ ] Custom training on chat history
- [ ] Webhook integrations
- [ ] Bot analytics dashboard