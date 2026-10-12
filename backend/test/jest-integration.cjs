const { database, integrationTests } = require('./jest-common.cjs');
module.exports = {
  ...database,
  testMatch: integrationTests.map((file) => `<rootDir>/${file}`),
};
