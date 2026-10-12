const integrationTests = [
  'src/modules/auth/auth.regression.spec.ts',
  'src/modules/order/order-state-machine.concurrent.spec.ts',
  'src/modules/order/order.transaction.spec.ts',
  'src/modules/session/session.lifecycle.spec.ts',
  'src/modules/vnpay/vnpay.transaction.spec.ts',
  'test/mongo-isolation.integration.spec.ts',
];

const base = {
  rootDir: '..',
  moduleFileExtensions: ['js', 'json', 'ts', 'cjs'],
  testEnvironment: 'node',
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
};

const database = {
  ...base,
  globalSetup: '<rootDir>/test/support/mongo-global-setup.cjs',
  globalTeardown: '<rootDir>/test/support/mongo-global-teardown.cjs',
  setupFilesAfterEnv: ['<rootDir>/test/support/mongo-setup.cjs'],
  maxWorkers: 2,
};

module.exports = { base, database, integrationTests };
