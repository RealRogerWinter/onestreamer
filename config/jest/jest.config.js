// Unit-test config. Keeps the wall-clock budget under ~20s by excluding the
// integration suite under server/tests/integration/ (run via
// `npm run test:integration`, separate config in jest.integration.config.js).
// PR 13.1 (Phase 13) introduced the split per the budget constraint in
// docs/architecture/plans/phases-6-plus.md §"Phase 13".
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // Exclusions:
  //   - /node_modules/                       — never run npm package tests
  //   - /tests/integration/                  — PR 13.1 suite split (run via npm run test:integration)
  //   - worktrees                            — .claude/worktrees/ leftovers from prior phases (would double-count tests)
  //   - EgressFrameCaptureService            — pulls @roamhq/wrtc native module, slow/unstable in CI
  //   - TranscriptionDrivenBotService        — pulls livekit-rtc-node native module
  //   - ChatBotLLMService.vision             — vision-model network calls
  //   - VisionBotService                     — vision-model network calls
  // These were the same set the Phase 10/11/12 baseline commands carried inline;
  // PR 13.1 moves them into the config so `npm test` works without CLI flags.
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/integration/',
    // chat-service has its own jest config + dedicated CI job (test-chat);
    // sweeping its tests here too ran them twice per pipeline (audit
    // follow-up). Run them via `cd chat-service && npx jest` / npm run
    // test:all.
    '/chat-service/',
    'worktrees',
    'EgressFrameCaptureService',
    'TranscriptionDrivenBotService',
    'ChatBotLLMService.vision',
    'VisionBotService',
    // better-sqlite3 contract tests run in their own process
    // (jest.bettersqlite.config.js); node-sqlite3 — loaded here as the
    // production-path driver — corrupts better-sqlite3 in the same process.
    '\\.bettersqlite\\.test\\.js$',
  ],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  collectCoverageFrom: [
    'server/services/**/*.js',
    '!server/tests/**',
    '!node_modules/**'
  ],
  setupFilesAfterEnv: ['<rootDir>/config/jest/jest.setup.js']
};