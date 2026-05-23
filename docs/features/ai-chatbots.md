# AI chatbots

_Last verified: 2026-05-23 against commit 4a1d325._

OneStreamer hosts a configurable population of LLM-driven chat participants. Bots appear as regular chat users (anonymous-style names like `[Animal][Number]`), generate contextual replies based on the last N messages, and can be enabled, disabled, tuned, and tested from the admin panel.

## Bot personas in the codebase

Three distinct bot classes exist, each with a different purpose:

| Bot | Triggered by | Purpose |
|-----|--------------|---------|
| **ChatBot** | Random interval + chat context | General conversation participant. Multiple instances can run with different personalities/prompts. |
| **MovieBot** | Always-on during active streams; combines chat history with live transcription | Stream commentary — reacts to what the streamer is doing/saying. Pad of 45–120 s between messages. |
| **StreamBot** | Fixed schedule | Announcement bot. Sends preset messages (e.g. shop reminders, feature highlights) on a timer. |

## LLM backends

The system has two backends, configured via env vars and selected at request time:

| Backend | When used | Env vars |
|---------|-----------|----------|
| **Ollama (local)** — default | Used if reachable at `OLLAMA_HOST` | `OLLAMA_HOST` (default `http://localhost:11434`), `OLLAMA_MODEL` (default `mistral`) |
| **Groq (cloud)** | Used if `GROQ_API_KEY` is set; can be selected per-bot or globally | `GROQ_API_KEY` |
| (none — hardcoded fallback) | If both providers are unreachable, [`ChatBotLLMService`](../../server/services/ChatBotLLMService.js) returns canned responses so the bot never goes silent | — |

Lightweight Ollama models that have been used successfully:

| Model | Size | Notes |
|-------|-----:|-------|
| `qwen2.5:0.5b` | ~400 MB | Fastest |
| `tinyllama` | ~700 MB | Good balance |
| `llama3.2:1b` | ~1.3 GB | |
| `gemma2:2b` | ~1.6 GB | |
| `llama3.2:3b` | ~2.0 GB | |
| `mistral` (default) | ~4.1 GB | Highest quality |

Groq models supported (selectable in admin panel):

- `llama-3.3-70b-versatile`
- `llama-3.1-8b-instant`
- `mixtral-8x7b-32768`
- Various Gemma variants

## Configuration

Admin endpoints (see [`server/routes/chatbots.js`](../../server/routes/chatbots.js)):

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/chatbots` | List bots |
| `POST` | `/api/chatbots` | Create bot |
| `PUT` | `/api/chatbots/:id` | Update bot |
| `DELETE` | `/api/chatbots/:id` | Delete bot |
| `GET` | `/api/chatbots/config` | Get global system prompt |
| `PUT` | `/api/chatbots/config` | Update global system prompt |
| `GET` | `/api/chatbots/models` | List available models |
| `PUT` | `/api/chatbots/models` | Switch active model |
| `GET` | `/api/chatbots/llm-status` | Probe LLM availability |

Per-bot fields:

- `name` — display name (or random `[Animal][Number]`)
- `prompt` — system prompt defining personality
- `response_interval_min` / `response_interval_max` — seconds between messages
- `personality_traits` — checkboxes (enthusiasm, casual, supportive, humorous, curious)
- `temperature` — LLM creativity (0.1–1.0)
- `show_robot_emoji` — prefix messages with 🤖 to flag bot status (optional)
- `is_enabled` — global on/off

## Prompt examples

```text
You are a friendly and enthusiastic viewer who loves watching streams and chatting with others.
```
```text
You are a knowledgeable gamer who loves discussing game strategies and sharing tips.
```
```text
You are super enthusiastic and love hyping up the stream! You use lots of exclamation marks!
```
```text
You are a relaxed viewer who occasionally chimes in with supportive comments.
```

## Architecture

```
ChatBotService (orchestrator, server/services/ChatBotService.js)
├── ChatBotLLMService           Ollama / Groq client + canned-fallback
│   ├── Ollama HTTP client
│   ├── Groq HTTP client
│   └── Fallback response set
├── Database persistence        chatbots, chatbot_sessions, chatbot_message_history
├── Per-bot Socket.IO clients   each bot opens a connection to the chat-service like a user
└── Scheduler                   per-bot random-interval timers within configured min/max
```

Per-bot resource footprint: ~5 MB memory + one socket connection. LLM resource cost is whatever the chosen model takes (Ollama runs alongside the OneStreamer server; Groq is remote, so only network cost).

## Database

Three tables, all in the main SQLite DB:

- `chatbots` — `id, name, prompt, is_enabled, response_interval_min/max, show_robot_emoji, personality_traits`
- `chatbot_sessions` — `chatbot_id, socket_id, username, color, connected_at, last_message_at`
- `chatbot_message_history` — `chatbot_id, message, context, created_at`

## Operations

| Symptom | First check |
|---------|-------------|
| Bots silent | Admin panel → ChatBots → LLM Status. If "unreachable", verify `curl http://localhost:11434/api/tags` and `pm2 logs onestreamer-server`. |
| Only fallback responses | Install/run Ollama; `ollama pull mistral`; restart the main server. |
| Connection errors | Check chat-service is up on `:8444`; check `CHAT_SERVICE_URL` env var; review server error log. |

## Code paths

| Concern | File |
|---------|------|
| Bot lifecycle | [`server/services/ChatBotService.js`](../../server/services/ChatBotService.js) |
| LLM abstraction | [`server/services/ChatBotLLMService.js`](../../server/services/ChatBotLLMService.js) |
| MovieBot logic | [`server/services/MovieBotService.js`](../../server/services/MovieBotService.js) |
| StreamBot (timed messages) | [`server/services/StreamBotService.js`](../../server/services/StreamBotService.js) |
| Admin UI | [`client/src/components/ChatBotManagement.tsx`](../../client/src/components/ChatBotManagement.tsx) |
| Admin endpoints | [`server/routes/chatbots.js`](../../server/routes/chatbots.js) |

## See also

- [`docs/integrations/ollama-and-groq.md`](../integrations/ollama-and-groq.md) — LLM provider setup
- [`docs/features/transcription.md`](transcription.md) — MovieBot consumes live transcription for context
- [`docs/features/chat-and-moderation.md`](chat-and-moderation.md) — how bot messages flow through the chat pipeline
