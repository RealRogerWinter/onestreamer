/**
 * Shared pino logger.
 *
 * Production: raw JSON to stdout — log aggregators (Loki, ELK, etc.)
 * consume that format directly.
 * Development: pino-pretty for human-readable colored output.
 *
 * `LOG_LEVEL` env var overrides the level. Defaults: `info` in production,
 * `debug` in development.
 *
 * Convention: see ADR-0020. Every service / route / middleware file
 * owns a module-scoped child logger:
 *     const logger = require('../bootstrap/logger').child({ svc: 'X' });
 * The `svc` binding shows up on every emitted line; production log
 * aggregators filter on it natively. PR 12.2 + PR 12.3 (Phase 12)
 * swept the entire server tree onto this pattern; only `scripts/` and
 * this file itself remain on `console.*`.
 *
 * Trace-ID mixin: when an HTTP request is in flight, the
 * `bootstrap/trace-context.js` AsyncLocalStorage layer puts a
 * `traceId` into the context. The `mixin` below picks it up and adds
 * it as a binding on every log line emitted from that request's
 * scope — so a production "what happened to this request?" query
 * collapses to `grep '"traceId":"abc123"'` against the JSON output.
 */

const pino = require('pino');
const { getTraceId } = require('./trace-context');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    mixin() {
        const traceId = getTraceId();
        return traceId ? { traceId } : {};
    },
    transport: isDev
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
});

module.exports = logger;
