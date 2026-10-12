import { createConnection, mongo } from 'mongoose';
import {
  clearTestCollections,
  testDatabaseName,
  testMongoUri,
} from './support/test-database';

describe('Owned test replica set and guarded cleanup', () => {
  it('supports transactions in the uniquely allocated database', async () => {
    const connection = await createConnection(testMongoUri()).asPromise();
    try {
      expect(connection.name).toBe(testDatabaseName());
      expect(connection.name).toMatch(/^smartorder_test_[a-f0-9]{32}$/);
      expect(await connection.db!.admin().command({ hello: 1 })).toMatchObject({
        setName: 'smartorderTest',
        isWritablePrimary: true,
      });
      const collection = connection.collection('isolation');
      await collection.insertOne({ marker: 'keep' });
      const session = await connection.startSession();
      try {
        session.startTransaction();
        await collection.insertOne({ marker: 'abort' }, { session });
        await session.abortTransaction();
      } finally {
        await session.endSession();
      }
      expect(await collection.countDocuments()).toBe(1);
      // Direct driver cleanup and a dbName override cannot bypass the guard.
      const foreign = new mongo.Db(connection.getClient(), 'app');
      expect(() => foreign.dropDatabase()).toThrow('Test Mongo guard');
      expect(() => foreign.collection('isolation').deleteMany({})).toThrow(
        'Test Mongo guard',
      );
      expect(() => createConnection(testMongoUri(), { dbName: 'app' })).toThrow(
        'Test Mongo guard',
      );
      await expect(
        clearTestCollections({ name: 'app' } as never),
      ).rejects.toThrow('Test Mongo guard');
      expect(await collection.countDocuments()).toBe(1);
      await connection.dropDatabase();
      expect(await collection.countDocuments()).toBe(0);
    } finally {
      await connection.close();
    }
  });
});
