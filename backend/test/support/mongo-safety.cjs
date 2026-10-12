const { randomUUID } = require('node:crypto');

const databasePattern = /^smartorder_(?:ai_demo_)?test_[a-f0-9]{32}$/;

function testDatabaseName(demo = false) {
  return `smartorder_${demo ? 'ai_demo_' : ''}test_${randomUUID().replaceAll('-', '')}`;
}

function assertTestUri(uri, dbName) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('Test Mongo guard: invalid URI');
  }
  const database = parsed.pathname.slice(1);
  if (
    parsed.protocol !== 'mongodb:' ||
    parsed.hostname !== '127.0.0.1' ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !databasePattern.test(database) ||
    (dbName !== undefined && dbName !== database) ||
    [...parsed.searchParams.keys()].some(
      (key) => !['directConnection', 'replicaSet'].includes(key),
    )
  ) {
    throw new Error(
      'Test Mongo guard: only a dedicated loopback test database is allowed',
    );
  }
  return parsed;
}

function assertScopedUri(uri, dbName, grantedUri) {
  assertTestUri(uri, dbName);
  if (!grantedUri || uri !== grantedUri) {
    throw new Error(
      'Test Mongo guard: database/server was not allocated to this suite',
    );
  }
}

function rejectExternalDatabaseEnv(env) {
  if (env.NODE_ENV === 'production')
    throw new Error('Test Mongo guard: production environment');
  for (const key of [
    'MONGODB_URI',
    'TEST_MONGODB_URI',
    'AI_DEMO_TEST_MONGODB_URI',
    'AI_DEMO_MONGODB_URI',
  ]) {
    if (env[key])
      throw new Error(
        `Test Mongo guard: unset ${key}; only an owned temporary replica set is supported`,
      );
  }
}

module.exports = {
  testDatabaseName,
  assertTestUri,
  assertScopedUri,
  rejectExternalDatabaseEnv,
};
