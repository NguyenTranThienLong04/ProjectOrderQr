import { mongo } from 'mongoose';
import { DATASET_ID } from './catalog';
import {
  buildDataset,
  COLLECTIONS,
  fingerprint,
  validateDataset,
} from './dataset';
import type { DemoDataset, DemoDocument } from './dataset';

export type DemoConfig = { uri: string; database: string };
export function requireDemoConfig(env: NodeJS.ProcessEnv): DemoConfig {
  if (!['development', 'test'].includes(env.NODE_ENV ?? ''))
    throw new Error(
      'AI demo requires explicit NODE_ENV=development or test; production is forbidden.',
    );
  if (env.AI_DEMO_ALLOW_WRITE !== 'I_UNDERSTAND_SYNTHETIC_DATA')
    throw new Error(
      'AI demo requires AI_DEMO_ALLOW_WRITE=I_UNDERSTAND_SYNTHETIC_DATA.',
    );
  const database = env.AI_DEMO_DB_NAME ?? '';
  if (!/^smartorder_ai_demo(?:_test_[a-z0-9]{1,32})?$/.test(database))
    throw new Error(
      'AI_DEMO_DB_NAME must be smartorder_ai_demo or smartorder_ai_demo_test_<unique suffix>.',
    );
  const uri = env.AI_DEMO_MONGODB_URI ?? '';
  // Parse only the URI path, never print the URI/credentials. Multi-host Mongo
  // URIs need not be accepted by WHATWG URL, so use a narrowly bounded parser.
  const match = /^mongodb(?:\+srv)?:\/\/[^/?#]+\/([^/?#]+)(?:\?[^#]*)?$/.exec(
    uri,
  );
  if (!match || match[1] !== database)
    throw new Error(
      'AI_DEMO_MONGODB_URI must explicitly name the exact dedicated demo database. No MONGODB_URI fallback.',
    );
  return { uri, database };
}

async function refuseLiveReferences(
  db: mongo.Db,
  session: mongo.ClientSession,
  dataset: DemoDataset,
): Promise<void> {
  const dishIds = dataset.dishes.map((dish) => dish._id);
  const categoryIds = dataset.categories.map((category) => category._id);
  // Refuse removing catalog used by interactive demo activity. No lifecycle
  // shortcuts or cascade deletes of cart/order/review data are permitted.
  const references: [string, mongo.Filter<mongo.Document>][] = [
    ['orders', { 'items.dishId': { $in: dishIds } }],
    [
      'sessions',
      {
        $or: [
          { 'cart.dishId': { $in: dishIds } },
          { 'preMergeCart.dishId': { $in: dishIds } },
          { 'postMergeRootCart.dishId': { $in: dishIds } },
        ],
      },
    ],
    ['reviews', { dishId: { $in: dishIds } }],
    ['dishes', { categoryId: { $in: categoryIds }, _id: { $nin: dishIds } }],
    [
      'ai_demo_baskets',
      { demoDataset: { $ne: DATASET_ID }, 'items.dishId': { $in: dishIds } },
    ],
    [
      'ai_demo_reviews',
      { demoDataset: { $ne: DATASET_ID }, dishId: { $in: dishIds } },
    ],
  ];
  for (const [collection, filter] of references) {
    if (await db.collection(collection).findOne(filter, { session }))
      throw new Error(
        `Reset refused: ${collection} contains a reference to demo catalog. Preserve or explicitly resolve that activity first.`,
      );
  }
}

/** No AppModule, startup hook, service override, payment authority or AI provider.
 * A transaction makes preflight + writes all-or-nothing on the existing Mongo
 * replica-set architecture. Exact document comparison preserves manual changes.
 * Concurrent seed/reset commands serialize through the namespace lock document.
 */
export async function runDemo(
  action: 'seed' | 'reset',
  env: NodeJS.ProcessEnv,
): Promise<Record<string, number>> {
  const config = requireDemoConfig(env);
  if (action === 'reset' && env.AI_DEMO_APP_STOPPED !== 'yes')
    throw new Error(
      'Reset refused: stop all applications using the demo DB, then set AI_DEMO_APP_STOPPED=yes to prevent new cart/order references during reset.',
    );
  const dataset = buildDataset();
  await validateDataset(dataset);
  const client = new mongo.MongoClient(config.uri, {
    serverSelectionTimeoutMS: 15000,
  });
  try {
    await client.connect();
    const db = client.db(config.database);
    const lock = db.collection<{
      _id: string;
      owner: string;
      revision: number;
    }>('ai_demo_control');
    // Creating collections is additive and does not modify existing documents.
    // Done before transaction for Mongo deployments restricting implicit DDL.
    for (const name of [...COLLECTIONS, 'ai_demo_control']) {
      if (!(await db.listCollections({ name }).hasNext())) {
        try {
          await db.createCollection(name);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !('code' in error) ||
            error.code !== 48
          )
            throw error;
        }
      }
    }
    const session = client.startSession();
    try {
      return await session.withTransaction(
        async () => {
          const existingLock = await lock.findOne(
            { _id: DATASET_ID },
            { session },
          );
          if (existingLock && existingLock.owner !== DATASET_ID)
            throw new Error(
              'Demo control namespace collision; no data changed.',
            );
          await lock.updateOne(
            { _id: DATASET_ID, owner: DATASET_ID },
            { $setOnInsert: { owner: DATASET_ID }, $inc: { revision: 1 } },
            { upsert: true, session },
          );
          const present = new Map<string, DemoDocument[]>();
          // Preflight ALL collections before mutation, including ID collisions and
          // unknown records that claim this dataset namespace.
          for (const name of COLLECTIONS) {
            const expected = dataset[name];
            const found = await db
              .collection<DemoDocument>(name)
              .find(
                {
                  $or: [
                    { _id: { $in: expected.map((doc) => doc._id) } },
                    { demoDataset: DATASET_ID },
                  ],
                },
                { session },
              )
              .toArray();
            for (const doc of found) {
              const original = expected.find((entry) =>
                entry._id.equals(doc._id),
              );
              if (!original || fingerprint(original) !== fingerprint(doc))
                throw new Error(
                  `Demo ${action} refused: ${name}/${doc._id.toString()} collides with or differs from the versioned fixture. No data changed.`,
                );
            }
            present.set(name, found);
          }
          if (action === 'reset')
            await refuseLiveReferences(db, session, dataset);
          const counts: Record<string, number> = {};
          for (const name of COLLECTIONS) {
            const found = present.get(name)!;
            if (action === 'seed') {
              const missing = dataset[name].filter(
                (entry) => !found.some((doc) => doc._id.equals(entry._id)),
              );
              if (missing.length)
                await db
                  .collection<DemoDocument>(name)
                  .insertMany(missing, { session });
              counts[name] = missing.length;
            } else {
              const result = await db.collection<DemoDocument>(name).deleteMany(
                {
                  demoDataset: DATASET_ID,
                  _id: { $in: found.map((doc) => doc._id) },
                },
                { session },
              );
              counts[name] = result.deletedCount;
            }
          }
          return counts;
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } finally {
      await session.endSession();
    }
  } finally {
    await client.close();
  }
}
