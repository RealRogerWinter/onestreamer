module.exports = {
  rootDir: '../..',
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
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