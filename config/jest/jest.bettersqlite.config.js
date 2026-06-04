// better-sqlite3 contract tests, isolated in their own jest process.
//
// better-sqlite3 and node-sqlite3 corrupt each other's error handling when
// loaded in the same process (better-sqlite3 stops throwing on errors). The
// main jest.config.js loads node-sqlite3 — the production-path driver — across
// many suites, so the better-sqlite3 contract tests (which assert better-sqlite3
// throws on syntax errors / constraint violations) run here instead, in a
// process that never requires node-sqlite3. The main config ignores
// `*.bettersqlite.test.js`; run this suite via `npm run test:bettersqlite`.
// See ADR-0014 (better-sqlite3 adapter) / ADR-0015 (withTransaction).
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.bettersqlite.test.js'],
  collectCoverage: false,
  setupFilesAfterEnv: ['<rootDir>/config/jest/jest.setup.js'],
};
