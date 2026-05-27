// Integration-test config. Sister of jest.config.js — see the comment there.
//
// The unit suite (npm test) targets <20s wall-clock and excludes anything
// under server/tests/integration/. This config picks up exactly the
// integration suite, has no wall-clock target, and skips coverage collection
// (integration tests verify end-to-end behavior, not line coverage).
//
// Both suites use the same jest.setup.js (env-flag defaults).
module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.js'],
  collectCoverage: false,
  setupFilesAfterEnv: ['<rootDir>/config/jest/jest.setup.js']
};
