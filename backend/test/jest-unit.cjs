const { base, integrationTests } = require('./jest-common.cjs');
module.exports = {
  ...base,
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/test/mongo-safety.spec.ts',
  ],
  testPathIgnorePatterns: integrationTests.map((file) =>
    file.replaceAll('.', '\\.'),
  ),
  setupFilesAfterEnv: ['<rootDir>/test/support/unit-setup.cjs'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts'],
  coverageDirectory: '<rootDir>/coverage',
};
