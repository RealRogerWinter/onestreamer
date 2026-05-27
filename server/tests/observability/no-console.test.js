/**
 * Regression check for ADR-0020 §"How to verify".
 *
 * Asserts that `console.*` callsites are absent from the server tree
 * (with the explicit allow-list: `server/bootstrap/logger.js` is
 * itself the canonical logger, and migration scripts under `scripts/`
 * are out-of-scope per the ADR).
 *
 * Failing this test means a recent PR (re-)introduced a stray
 * `console.log` somewhere in `server/{services,routes,bootstrap,
 * middleware,database}`. The fix is to swap it for the namespaced
 * `logger.X(...)` per the ADR. If a deliberate exception is needed
 * (vanishingly rare), add the file to ALLOWED below with a comment
 * explaining why.
 */

const { execSync } = require('child_process');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

// Files allowed to retain `console.*`. Keep this list as small as
// possible — every entry is a hole in the convention.
const ALLOWED = new Set([
    // The logger module itself. It does not call console.* in code, but
    // it would be circular if it did. Listed for completeness.
    'server/bootstrap/logger.js',
]);

describe('ADR-0020 regression — no console.* in server/', () => {
    it('the server tree has zero console.* callsites outside the allow-list', () => {
        const result = execSync(
            `grep -rlE "console\\.(log|info|warn|error|debug)" ` +
            `server/services server/routes server/bootstrap server/middleware server/database ` +
            `--include="*.js" || true`,
            { cwd: repoRoot, encoding: 'utf-8' },
        );
        const files = result.split('\n').filter(Boolean).filter((f) => !ALLOWED.has(f));
        if (files.length > 0) {
            const lines = execSync(
                `grep -nE "console\\.(log|info|warn|error|debug)" ${files.map((f) => `"${f}"`).join(' ')} || true`,
                { cwd: repoRoot, encoding: 'utf-8' },
            );
            throw new Error(
                `Found ${files.length} server file(s) still using \`console.*\`. ` +
                `Migrate to the namespaced pino logger per ADR-0020.\n\n${lines}`,
            );
        }
        expect(files).toEqual([]);
    });
});
