require('./no-env.cjs');
const mongoose = require('mongoose');
const {
  testDatabaseName,
  assertTestUri,
  assertScopedUri,
} = require('./mongo-safety.cjs');

const owned = assertTestUri(process.env.OWNED_TEST_MONGO_URI);
const dbName = testDatabaseName(
  expect.getState().testPath.includes('ai-demo.e2e'),
);
owned.pathname = `/${dbName}`;
owned.searchParams.set('replicaSet', 'smartorderTest');
const uri = owned.toString();
process.env.TEST_MONGODB_URI = uri;
// AppModule still consumes this key; its value comes only from the private harness.
process.env.MONGODB_URI = uri;
Object.assign(process.env, {
  NODE_ENV: 'test',
  AI_ENABLED: 'false',
  AI_PROVIDER: 'mock',
  JWT_ACCESS_SECRET: 'test-only-access-012345678901234567890',
  JWT_REFRESH_SECRET: 'test-only-refresh-012345678901234567890',
  CUSTOMER_ACCESS_SECRET: 'test-only-customer-012345678901234567890',
  VNP_HASH_SECRET: 'test-only-payment-secret',
  VNP_TMN_CODE: 'TESTCODE',
  VNP_RETURN_URL: 'http://127.0.0.1/payment-result',
  VNP_URL: 'http://127.0.0.1/payment-provider-disabled',
  FRONTEND_URL: 'http://127.0.0.1:5173',
  CLOUDINARY_CLOUD_NAME: 'test-only',
  CLOUDINARY_API_KEY: 'test-only',
  CLOUDINARY_API_SECRET: 'test-only',
});
delete process.env.CUSTOM_DNS_SERVERS;

function assertDatabase(name) {
  assertScopedUri(uri, name, uri);
}
const openUri = mongoose.Connection.prototype.openUri;
mongoose.Connection.prototype.openUri = function (candidate, options) {
  assertScopedUri(candidate, options?.dbName, uri);
  return openUri.call(this, candidate, options);
};
const { MongoClient, Db, Collection } = mongoose.mongo;
const connect = MongoClient.prototype.connect;
MongoClient.prototype.connect = function (...args) {
  const options = this.options;
  assertDatabase(options.dbName);
  if (
    options.hosts.length !== 1 ||
    options.hosts[0].host !== '127.0.0.1' ||
    options.hosts[0].port !== Number(owned.port)
  ) {
    throw new Error(
      'Test Mongo guard: server was not allocated by the harness',
    );
  }
  return connect.apply(this, args);
};
const db = MongoClient.prototype.db;
MongoClient.prototype.db = function (name, ...args) {
  assertDatabase(name ?? this.options.dbName);
  return db.call(this, name, ...args);
};
// Guard destructive operations at the driver too, including direct collection use.
for (const [prototype, methods] of [
  [Db.prototype, ['dropDatabase', 'dropCollection']],
  [Collection.prototype, ['deleteMany', 'deleteOne', 'drop']],
]) {
  for (const method of methods) {
    const original = prototype[method];
    prototype[method] = function (...args) {
      assertDatabase(this.databaseName ?? this.dbName);
      return original.apply(this, args);
    };
  }
}

// Keep callable business methods, but never start demo seeding or cleanup timers.
const { AppService } = require('../../src/app.service');
const {
  AbandonedSessionCleanupService,
} = require('../../src/modules/session/abandoned-session-cleanup.service');
AppService.prototype.onApplicationBootstrap = async function () {};
AbandonedSessionCleanupService.prototype.onApplicationBootstrap =
  function () {};

afterAll(async () => {
  // Close connections even when a fixture's setup/teardown failed halfway through.
  await Promise.all(
    mongoose.connections.map((connection) => connection.close()),
  );
  const cleanup = await mongoose.createConnection(uri).asPromise();
  try {
    await cleanup.dropDatabase();
  } finally {
    await cleanup.close();
  }
}, 15000);
