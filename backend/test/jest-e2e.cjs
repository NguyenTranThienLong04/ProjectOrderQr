const { database } = require('./jest-common.cjs');
module.exports = { ...database, testMatch: ['<rootDir>/test/*.e2e-spec.ts'] };
