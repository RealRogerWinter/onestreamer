/**
 * BotEventBus
 *
 * Decouples ChatBotService and MovieBotService. Previously they held direct
 * references to each other, wired via a post-construction setter in
 * bootstrap/services.js — a circular dep that forced the factory to
 * construct MovieBot before calling chatBot.setMovieBotService(movieBot).
 *
 * Today the only cross-call from ChatBot → MovieBot is a fire-and-forget
 * "a new chat message arrived" signal (was: `movieBot.addChatMessage(...)`).
 * With the bus, ChatBot emits the message; MovieBot subscribes. No direct
 * reference needed, no setter, no construction order constraint.
 *
 * MovieBot → ChatBot is still a direct reference (request/response shape:
 * generateMovieComment, getMovieBotEnabledBots, llmService config). That
 * direction isn't event-shaped and isn't worth contorting through a bus.
 *
 * Events:
 *   - 'chat-message'  payload: { username, message }
 *
 * The class is a thin EventEmitter wrapper rather than a re-export so we
 * can constrain the shape if the surface grows (typed events, payload
 * validation, etc.) without rewriting subscribers.
 */

const EventEmitter = require('events');

class BotEventBus extends EventEmitter {
    constructor() {
        super();
        // EventEmitter defaults to 10-listener warning; we expect at most
        // a handful of subscribers per event so the default is fine.
    }

    // Lifecycle entry point. The class wraps a pure in-memory EventEmitter
    // today, so stop() just removes every listener. The hook exists so the
    // bootstrap shutdown loop can include the bus uniformly if/when this
    // ever wraps a Redis publisher or cross-process bridge.
    async stop() {
        this.removeAllListeners();
    }
}

module.exports = BotEventBus;
