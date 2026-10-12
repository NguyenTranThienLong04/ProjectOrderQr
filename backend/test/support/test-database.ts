import type { Connection } from 'mongoose';

// The Jest database setup allocates and guards this URI before loading any suite.
export function testMongoUri(): string {
  const uri = process.env.TEST_MONGODB_URI;
  if (!uri)
    throw new Error(
      'Use the integration/E2E Jest config to allocate a test database',
    );
  return uri;
}

export function testDatabaseName(): string {
  return new URL(testMongoUri()).pathname.slice(1);
}

export async function clearTestCollections(
  connection: Connection,
): Promise<void> {
  const uri = new URL(testMongoUri());
  if (
    connection.name !== testDatabaseName() ||
    connection.host !== uri.hostname ||
    connection.port !== Number(uri.port)
  ) {
    throw new Error(
      'Test Mongo guard: refusing cleanup outside this suite database',
    );
  }
  await Promise.all(
    Object.values(connection.models).map((model) => model.deleteMany({})),
  );
}
