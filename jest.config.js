module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/server.js'],
  testEnvironment: 'node',
  setupFiles: ['reflect-metadata', '<rootDir>/test/setup-env.js'],
};
