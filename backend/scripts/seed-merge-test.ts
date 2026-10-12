/** Deprecated: merge-test fixtures now belong to the isolated E2E harness. */
export function seedMergeTestData(_connection?: unknown): never {
  throw new Error(
    'Test Mongo guard: seeding merge fixtures into an existing database is disabled. ' +
      'Set MONGOD_BINARY and run npm run test:e2e -- --runTestsByPath test/session-merge.e2e-spec.ts.',
  );
}

if (require.main === module) seedMergeTestData();
