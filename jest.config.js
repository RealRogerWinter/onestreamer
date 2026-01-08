module.exports = {
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
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js']
};