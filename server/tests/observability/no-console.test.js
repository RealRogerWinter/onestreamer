/**
 * Regression check for ADR-0020 §"How to verify".
 *
 * Asserts that `console.*` callsites are absent from the server tree
 * (with the explicit allow-list: `server/bootstrap/logger.js` is
 * itself the canonical logger, and migration scripts under `scripts/`
 * are out-of-scope per the ADR).
 *
 * Scope (post-Phase-15A): the entire `server/` JS surface that
 * shipped Phase 15A's three sweeps —
 *   server/services, server/routes, server/bootstrap, server/middleware,
 *   server/database, server/sockets, server/config, server/index.js
 *
 * Failing this test means a recent PR (re-)introduced a stray
 * `console.log` somewhere in that scope. The fix is to swap it for the
 * namespaced `logger.X(...)` per the ADR. If a deliberate exception is
 * needed (vanishingly rare), one of two escape hatches applies:
 *
 *   1) Add the *file* to ALLOWED below with a comment explaining why.
 *   2) For per-line exceptions (e.g. the `uncaughtException` /
 *      `unhandledRejection` fallbacks in `server/index.js`, which keep
 *      raw `console.error` so if pino itself faulted we still get stderr
 *      output), add the literal comment `// console-allowed: <reason>`
 *      on the *immediately preceding* line. This test skips any
 *      `console.*` line whose previous line carries that marker.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

// Files allowed to retain `console.*`. Keep this list as small as
// possible — every entry is a hole in the convention.
const ALLOWED = new Set([
    // The logger module itself. It does not call console.* in code, but
    // it would be circular if it did. Listed for completeness.
    'server/bootstrap/logger.js',
]);

const MARKER = '// console-allowed:';
const CONSOLE_PATTERN = /\bconsole\.(log|info|warn|error|debug)\b/;

// Scope: directories + the single index.js file. PR 15A.3 expanded this
// list to cover `server/sockets`, `server/config`, and `server/index.js`
// (PR 12.3 had swept only the first five dirs).
const SCOPE = [
    'server/services',
    'server/routes',
    'server/bootstrap',
    'server/middleware',
    'server/database',
    'server/sockets',
    'server/config',
    'server/index.js',
];

describe('ADR-0020 regression — no console.* in server/', () => {
    it('the server tree has zero console.* callsites outside the allow-list or per-line markers', () => {
        // Find every file in scope that contains at least one `console.X` token.
        const grepArgs = SCOPE.map((p) => `"${p}"`).join(' ');
        const result = execSync(
            `grep -rlE "console\\.(log|info|warn|error|debug)" ${grepArgs} --include="*.js" || true`,
            { cwd: repoRoot, encoding: 'utf-8' },
        );
        const candidateFiles = result.split('\n').filter(Boolean).filter((f) => !ALLOWED.has(f));

        // Per-line filter: for each candidate file, walk lines and report
        // every `console.X` whose previous line does NOT carry the marker.
        const violations = [];
        for (const relPath of candidateFiles) {
            const abs = path.join(repoRoot, relPath);
            const lines = fs.readFileSync(abs, 'utf-8').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (!CONSOLE_PATTERN.test(lines[i])) continue;
                const prev = i > 0 ? lines[i - 1] : '';
                if (prev.includes(MARKER)) continue; // skipped
                violations.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
            }
        }

        if (violations.length > 0) {
            throw new Error(
                `Found ${violations.length} \`console.*\` callsite(s) in scope.\n` +
                `Migrate to the namespaced pino logger per ADR-0020, or — for the\n` +
                `extreme-rare fallback case (e.g. uncaughtException) — add the literal\n` +
                `comment \`// console-allowed: <reason>\` on the immediately preceding line.\n\n` +
                violations.join('\n'),
            );
        }
        expect(violations).toEqual([]);
    });
});
