import { createConnection } from 'mongoose';
import { seedMergeTestData } from '../scripts/seed-merge-test';
const {
  assertTestUri,
  assertScopedUri,
  rejectExternalDatabaseEnv,
  testDatabaseName,
} = require('./support/mongo-safety.cjs');

describe('Test database safety', () => {
  it('rejects app/dev/prod/unmarked/remote URIs and database overrides', () => {
    const uri = `mongodb://127.0.0.1:27017/${testDatabaseName()}`;
    expect(() => assertTestUri(uri)).not.toThrow();
    for (const name of [
      'app',
      'smartorder',
      'dev',
      'production',
      'test',
      'smartorder_test_prod',
    ]) {
      expect(() => assertTestUri(`mongodb://127.0.0.1:27017/${name}`)).toThrow(
        'Test Mongo guard',
      );
    }
    expect(() =>
      assertTestUri(uri.replace('127.0.0.1', 'production.example')),
    ).toThrow();
    expect(() => assertTestUri(uri, 'app')).toThrow();
    expect(() => assertTestUri(`${uri}?authSource=admin`)).toThrow();
    expect(() => assertScopedUri(uri, undefined, `${uri}0`)).toThrow();
    for (const key of [
      'MONGODB_URI',
      'TEST_MONGODB_URI',
      'AI_DEMO_TEST_MONGODB_URI',
      'AI_DEMO_MONGODB_URI',
    ]) {
      expect(() => rejectExternalDatabaseEnv({ [key]: uri })).toThrow(
        `unset ${key}`,
      );
    }
    expect(() =>
      rejectExternalDatabaseEnv({ NODE_ENV: 'production' }),
    ).toThrow();
    expect(() => seedMergeTestData()).toThrow('Test Mongo guard');
  });

  it('prevents unit tests from opening even a test MongoDB connection', () => {
    expect(() =>
      createConnection(`mongodb://127.0.0.1:27017/${testDatabaseName()}`),
    ).toThrow('Unit tests cannot connect');
  });
});
