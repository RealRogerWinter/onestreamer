/**
 * Aggregate fail-fast validation of required environment variables.
 *
 * requireEnv() in `server/config/requireEnv.js` throws on the first missing
 * var — fine for individual files, but the operator hits "fix one, restart,
 * see next miss, repeat." `validateEnv()` surfaces all missing/malformed
 * vars in a single error so the operator can fix them in one pass.
 *
 * Called once near the top of `server/index.js`, after `dotenv.config()` but
 * before any other `require()` that imports a file calling `requireEnv()`.
 * Existing `requireEnv()` callsites stay as a secondary safety net — if a
 * future required var is added to a route file without being added here,
 * `requireEnv` will still throw at that file's module load.
 */

// The four secrets `.env.example` marks REQUIRED. `ADMIN_KEY` is deliberately
// not here — it's documented in docs/getting-started/environment-variables.md
// as a legacy key without a length requirement, and its existing
// requireEnv('ADMIN_KEY') callsite in server/index.js still enforces presence.
const REQUIRED = [
    { name: 'JWT_SECRET',           minLength: 32, hint: 'openssl rand -base64 48' },
    { name: 'SESSION_SECRET',       minLength: 32, hint: 'openssl rand -base64 48' },
    { name: 'TURN_SECRET',          minLength: 16, hint: 'must match /etc/turnserver.conf static-auth-secret' },
    { name: 'TURNSTILE_SECRET_KEY', minLength: 1,  hint: 'Cloudflare Turnstile site secret' },
];

function validateEnv(env = process.env) {
    const problems = [];
    for (const spec of REQUIRED) {
        const value = env[spec.name];
        if (!value) {
            problems.push(`  ✗ ${spec.name} is missing — ${spec.hint}`);
            continue;
        }
        if (spec.minLength && value.length < spec.minLength) {
            problems.push(
                `  ✗ ${spec.name} is too short ` +
                `(${value.length} chars, need ≥ ${spec.minLength}) — ${spec.hint}`
            );
        }
    }
    if (problems.length === 0) return;
    throw new Error(
        `Refusing to start: ${problems.length} environment variable problem(s):\n` +
        problems.join('\n') + '\n' +
        `See .env.example for the full schema.`
    );
}

module.exports = { validateEnv, REQUIRED };
