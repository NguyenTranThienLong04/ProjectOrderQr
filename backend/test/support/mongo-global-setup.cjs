const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, realpathSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { MongoClient } = require('mongoose').mongo;
const {
  testDatabaseName,
  assertTestUri,
  rejectExternalDatabaseEnv,
} = require('./mongo-safety.cjs');

module.exports = async () => {
  rejectExternalDatabaseEnv(process.env);
  if (!process.env.MONGOD_BINARY)
    throw new Error(
      'MONGOD_BINARY is required for database tests (no skipped suites)',
    );
  const directory = mkdtempSync(join(tmpdir(), 'smartorder-test-'));
  const root = realpathSync(tmpdir());
  let child;
  let client;
  const stop = async () => {
    await client?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Temporary mongod did not stop')),
          10000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      });
    }
    // Only remove the exact directory created by this invocation.
    if (
      dirname(realpathSync(directory)) !== root ||
      !directory.startsWith(join(tmpdir(), 'smartorder-test-'))
    ) {
      throw new Error(
        'Test Mongo guard: refusing unsafe temporary directory cleanup',
      );
    }
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  };
  try {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
    });
    const uri = `mongodb://127.0.0.1:${port}/${testDatabaseName()}?directConnection=true`;
    assertTestUri(uri);
    child = spawn(
      process.env.MONGOD_BINARY,
      [
        '--dbpath',
        directory,
        '--bind_ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--replSet',
        'smartorderTest',
        '--logpath',
        join(directory, 'mongo.log'),
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    const failed = new Promise((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        reject(new Error(`Temporary mongod exited during startup (${code})`)),
      );
    });
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
    await Promise.race([client.connect(), failed]);
    const admin = client.db().admin();
    // A port allocation race must never let us initialize an unrelated server.
    const status = await admin.command({ serverStatus: 1 });
    if (Number(status.pid) !== child.pid)
      throw new Error(
        'Test Mongo guard: connected server is not the owned process',
      );
    await admin.command({
      replSetInitiate: {
        _id: 'smartorderTest',
        members: [{ _id: 0, host: `127.0.0.1:${port}` }],
      },
    });
    const deadline = Date.now() + 20000;
    while (!(await admin.command({ hello: 1 })).isWritablePrimary) {
      if (Date.now() > deadline)
        throw new Error('Temporary replica set did not elect a primary');
      await delay(50);
    }
    await client.close();
    client = undefined;
    process.env.OWNED_TEST_MONGO_URI = uri;
    global.__stopTestMongo = stop;
  } catch (error) {
    await stop();
    throw error;
  }
};
