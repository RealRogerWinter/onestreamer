# Ollama and Groq

_Last verified: 2026-05-23 against commit 4a1d325._

LLM providers for the AI chatbot system (MovieBot, ChatBot, StreamBot). Two backends with a documented preference order: **Ollama (local) first**, **Groq (cloud) as fallback**, **canned responses if neither works**. See [`/docs/features/ai-chatbots.md`](../features/ai-chatbots.md) for what the bots do; this page covers how they get their text.

## Provider selection logic

[`ChatBotLLMService`](../../server/services/ChatBotLLMService.js) at request time:

1. Try **Ollama** at `OLLAMA_HOST` (default `http://localhost:11434`). If reachable and the configured model is loaded, use it.
2. Else, try **Groq** if `GROQ_API_KEY` is set.
3. Else, return a canned response from a hardcoded set so the bot never goes completely silent.

This means **either provider is sufficient** for chatbots to function — and the canned fallback ensures graceful degradation when both are down.

---

## Ollama (local)

[Ollama](https://ollama.ai) is a local LLM runtime — pulls and serves quantized models from a model zoo, exposes a simple HTTP API.

### Setup

```bash
# Install (Linux)
curl -fsSL https://ollama.ai/install.sh | sh
# Or download from https://ollama.ai for macOS / Windows

# Start the daemon
ollama serve              # foreground; or systemd-managed on Linux

# Pull a model (one-time per model)
ollama pull mistral       # ~4 GB, the default
ollama pull tinyllama     # ~700 MB, faster but lower quality

# Confirm
curl http://localhost:11434/api/tags
```

### Env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama HTTP endpoint |
| `OLLAMA_MODEL` | `mistral` | Default model name |

### Models OneStreamer has used

| Model | Size | Speed | Quality |
|-------|-----:|-------|---------|
| `qwen2.5:0.5b` | ~400 MB | Fastest | Basic |
| `tinyllama` | ~700 MB | Fast | Good balance for chat |
| `llama3.2:1b` | ~1.3 GB | Medium | Better than tinyllama |
| `gemma2:2b` | ~1.6 GB | Medium | |
| `llama3.2:3b` | ~2.0 GB | Slow | High |
| `mistral` (default) | ~4.1 GB | Slow | Best |

Pick based on the host's RAM/CPU budget. A 4 GB model running on a host that's also running the LiveKit server, recording, and transcription is a tight fit — start small.

### Switching models at runtime

Admin panel → ChatBots tab → Select Model → Apply. This updates the LLM service's active model without restarting. The new model is pulled (`ollama pull <model>`) automatically if not already present.

### Operational notes

- **One Ollama daemon per host.** Don't try to run multiple `ollama serve` processes.
- **Model loading is lazy** — first request after a model switch takes longer (loads weights into RAM).
- **GPU acceleration**, if available, is automatic. Without a GPU, models run on CPU and are noticeably slower.
- **RAM is the bottleneck**, not disk. A 4 GB model needs ~6 GB RAM resident. Bigger models need more.

### Troubleshooting

| Symptom | Check |
|---------|-------|
| `connection refused` on `:11434` | `ollama serve` not running. `systemctl status ollama` or restart manually. |
| Model not found | `ollama list` to see what's pulled; `ollama pull <model>` to fetch. |
| Slow responses | Smaller model, or check `htop` — Ollama is sharing CPU with other services. |
| Out of memory | Drop to a smaller model; check `free -h`. |

---

## Groq (cloud, optional)

[Groq](https://groq.com) is a fast cloud LLM API with generous free-tier limits. OneStreamer uses it as a fallback for when Ollama isn't available — or as a primary if you'd rather avoid running the model locally.

### Setup

1. Sign up at [console.groq.com](https://console.groq.com).
2. Create an API key.
3. Set `GROQ_API_KEY=<your-key>` in `.env`.
4. Restart the main server.

### Env vars

| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | API key from console.groq.com |

### Supported models

The admin panel lets you pick from the Groq-supported model list. Common choices:

- `llama-3.3-70b-versatile` — high quality, slower
- `llama-3.1-8b-instant` — fast, good quality
- `mixtral-8x7b-32768` — wide context window
- Various Gemma variants

Model availability changes — check [groq.com](https://groq.com) for the current list.

### Operational notes

- **Per-request cost** — Groq's free tier covers light usage; heavy chatbot activity may push you to paid.
- **Latency** — typically 200–800 ms per response (faster than most cloud LLMs but slower than local Ollama on the same hardware running a small model).
- **Rate limits** — apply per-API-key. Heavy MovieBot use can hit them; the canned fallback catches the overflow gracefully.

### Troubleshooting

| Symptom | Check |
|---------|-------|
| `401 Unauthorized` | API key is wrong or revoked. Rotate via [`/docs/operations/runbooks/secret-rotation.md`](../operations/runbooks/secret-rotation.md). |
| `429 Too Many Requests` | Rate-limited. Either upgrade your Groq plan or accept that some bot responses fall back to canned text. |
| `model not found` | Groq has deprecated or renamed a model. Pick a different one in the admin panel. |

---

## Canned fallback

If both Ollama and Groq are unreachable, [`ChatBotLLMService`](../../server/services/ChatBotLLMService.js) returns a response from a hardcoded set ("Hey", "lol", "what's up", topic-agnostic acknowledgements). The bot never goes silent.

This is a feature, not a bug — chatbots that suddenly stop responding when the LLM provider hiccups look broken to users. Canned fallbacks degrade gracefully.

## Code paths

| Concern | File |
|---------|------|
| Provider abstraction | [`server/services/ChatBotLLMService.js`](../../server/services/ChatBotLLMService.js) |
| Bot orchestration | [`server/services/ChatBotService.js`](../../server/services/ChatBotService.js) |
| MovieBot logic | [`server/services/MovieBotService.js`](../../server/services/MovieBotService.js) |
| StreamBot logic | [`server/services/StreamBotService.js`](../../server/services/StreamBotService.js) |
| Admin UI for provider/model selection | [`client/src/components/admin/ChatBotManagement.tsx`](../../client/src/components/admin/ChatBotManagement.tsx) |
| Admin endpoints | [`server/routes/chatbots.js`](../../server/routes/chatbots.js) |

## See also

- [`/docs/features/ai-chatbots.md`](../features/ai-chatbots.md) — what the bots do
- [`/docs/features/transcription.md`](../features/transcription.md) — MovieBot consumes transcripts (transcription is also local, via Whisper)
- [`whisper.md`](whisper.md) — the local-only transcription side of the AI story
- [Ollama docs](https://github.com/ollama/ollama/blob/main/docs/README.md)
- [Groq docs](https://console.groq.com/docs)
