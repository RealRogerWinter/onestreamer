/**
 * Request-scoped trace context (ADR-0020 §4).
 *
 * Generates a short trace ID per HTTP request and propagates it through
 * the async call chain via `AsyncLocalStorage`. The bootstrap logger
 * picks the ID up via its `mixin` and stamps `"traceId":"..."` onto
 * every log line emitted from within the request scope. The chokepoint
 * notifiers (StreamNotifier, ViewerCountNotifier, BuffNotifier) also
 * include the ID as `_traceId` on their socket-event payloads so a
 * single grep can correlate the originating HTTP route, every server-
 * side log line it caused, and the socket emit it produced.
 *
 * Public surface (kept minimal — anything else can live in callers):
 *
 *   getTraceId()
 *     -> string|undefined  // current scope's trace ID, if any
 *
 *   runWithTraceId(traceId, fn)
 *     -> whatever fn returns  // explicit scope opening, used by tests
 *
 *   expressMiddleware(req, res, next)
 *     -> void  // honours an inbound `X-Trace-Id` header for chained
 *              // services; otherwise mints a fresh 8-char ID. Echoes
 *              // the ID back on the response header so the client
 *              // can correlate too.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

const storage = new AsyncLocalStorage();

function getTraceId() {
    const store = storage.getStore();
    return store ? store.traceId : undefined;
}

function runWithTraceId(traceId, fn) {
    return storage.run({ traceId }, fn);
}

function makeTraceId() {
    // 8 chars is enough to disambiguate within a short log window
    // and short enough not to clutter log output.
    return randomUUID().replace(/-/g, '').slice(0, 8);
}

function expressMiddleware(req, res, next) {
    const incoming = req.headers['x-trace-id'];
    const traceId = (typeof incoming === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(incoming))
        ? incoming
        : makeTraceId();
    res.setHeader('x-trace-id', traceId);
    runWithTraceId(traceId, next);
}

module.exports = { getTraceId, runWithTraceId, makeTraceId, expressMiddleware };
