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
 * The bulk of the codebase still uses `console.*` and migrates
 * opportunistically — this module exists so new code (and any of the
 * noisiest existing sites a refactor touches) has a structured target.
 */

const pino = require('pino');

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
    transport: isDev
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
});

module.exports = logger;
