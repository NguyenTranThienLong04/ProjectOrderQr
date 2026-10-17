/** Explicit CLI only. Never import this script from application startup. */
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { setServers } from 'node:dns';
import { parse } from 'dotenv';
import { mongo } from 'mongoose';
import {
  PaymentIntentSchema,
  UNRESOLVED_PAYMENT_FILTER,
} from '../src/modules/vnpay/payment-intent.schema';

export const SESSION_INDEX = 'one_unresolved_checkout_per_session';
export const ORDER_INDEX = 'one_unresolved_checkout_per_order';
const COLLECTION = 'payment_intents';
type Receipt = Record<string, string>;
type Intent = {
  _id: mongo.ObjectId;
  sessionId: mongo.ObjectId;
  txnRef: string;
  status: string;
  ipnConfirmed?: boolean | null;
  amount: number;
  coveredOrderIds?: mongo.ObjectId[];
  expiresAt?: Date;
  createdAt?: Date;
  completedAt?: Date | null;
  transactionNo?: string;
  responseCode?: string;
  paymentMethod?: string;
  [key: string]: unknown;
};
type Order = {
  _id: mongo.ObjectId;
  sessionId: mongo.ObjectId;
  status: string;
  paidAt?: Date | null;
  totalAmount: number;
  statusHistory?: { toStatus: string; transactionNo?: string }[];
  [key: string]: unknown;
};
type Group = { _id: mongo.ObjectId; count: number };
type Snapshot = { groups: Group[]; intents: Intent[]; orders: Order[] };
type Failure = { responseCode: string; transactionNo: string; source: string };
export type PortalEvidence = {
  source: 'vnpay-sandbox-merchant-portal';
  capturedAt: string;
  payments: {
    tmnCode: string;
    txnRef: string;
    amount: number;
    currency: 'VND';
    status: 'succeeded';
    responseCode: '00';
    transactionNo: string;
    confirmedAt: string;
    sourceUrl: string;
  }[];
};
type Resolution = Failure & {
  status: 'failed' | 'succeeded';
  completedAt?: Date;
};
export type MigrationOptions = {
  apply?: boolean;
  writesPaused?: boolean;
  backupDirectory: string;
  receipts?: Receipt[];
  portalEvidence?: PortalEvidence;
  tmnCode?: string;
  hashSecret?: string;
  log?: (record: unknown) => void;
};

function serialize(value: unknown): string {
  return mongo.BSON.EJSON.stringify(value, { relaxed: false });
}
function digest(value: unknown): string {
  return createHash('sha256').update(serialize(value)).digest('hex');
}
function unresolved(intent: Intent): boolean {
  return (
    intent.status === 'pending' ||
    (intent.status === 'failed' &&
      (intent.ipnConfirmed == null || intent.ipnConfirmed === false))
  );
}

async function snapshot(
  db: mongo.Db,
  session?: mongo.ClientSession,
): Promise<Snapshot> {
  const groups = await db
    .collection<Intent>(COLLECTION)
    .aggregate<Group>(
      [
        { $match: UNRESOLVED_PAYMENT_FILTER },
        {
          $group: { _id: '$sessionId', count: { $sum: 1 } },
        },
        { $match: { count: { $gt: 1 } } },
        { $sort: { _id: 1 } },
      ],
      { session },
    )
    .toArray();
  const ids = groups.map((group) => group._id);
  const intents = await db
    .collection<Intent>(COLLECTION)
    .find({ sessionId: { $in: ids } }, { session })
    .sort({ _id: 1 })
    .toArray();
  const orders = await db
    .collection<Order>('orders')
    .find(
      {
        $or: [
          { sessionId: { $in: ids } },
          { _id: { $in: intents.flatMap((i) => i.coveredOrderIds ?? []) } },
        ],
      },
      { session },
    )
    .sort({ _id: 1 })
    .toArray();
  return { groups, intents, orders };
}

/** Same signed terminal-failure contract as VnpayService.handleIpn().
 * Expiry, a browser return, or payment via another txnRef is NOT failure evidence.
 */
function confirmedFailure(
  intent: Intent,
  options: MigrationOptions,
): Failure | undefined {
  if (
    intent.paymentMethod === 'internal_zero' ||
    !Number.isSafeInteger(intent.amount * 100) ||
    intent.amount <= 0
  )
    return;
  if (
    intent.ipnConfirmed === true &&
    /^\d{2}$/.test(intent.responseCode ?? '') &&
    intent.responseCode !== '00' &&
    /^\d+$/.test(intent.transactionNo ?? '') &&
    intent.completedAt instanceof Date &&
    Number.isFinite(intent.completedAt.getTime())
  ) {
    return {
      responseCode: intent.responseCode!,
      transactionNo: intent.transactionNo!,
      source: 'persisted-confirmed-failure',
    };
  }
  // Never override a contradictory success marker using a supplied failure receipt.
  if (intent.ipnConfirmed === true || intent.responseCode === '00') return;
  const receipts = (options.receipts ?? []).filter(
    (r) => r.vnp_TxnRef === intent.txnRef,
  );
  if (receipts.length !== 1 || !options.hashSecret || !options.tmnCode) return;
  const receipt = receipts[0];
  if (
    Object.values(receipt).some((value) => typeof value !== 'string') ||
    receipt.vnp_TmnCode !== options.tmnCode ||
    receipt.vnp_TransactionStatus !== '02' ||
    !/^\d{2}$/.test(receipt.vnp_ResponseCode) ||
    receipt.vnp_ResponseCode === '00' ||
    !/^\d+$/.test(receipt.vnp_TransactionNo) ||
    !/^\d+$/.test(receipt.vnp_Amount) ||
    Number(receipt.vnp_Amount) !== intent.amount * 100 ||
    !/^[a-fA-F0-9]{128}$/.test(receipt.vnp_SecureHash)
  )
    return;
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/%20/g, '+');
  const data = Object.keys(receipt)
    .filter(
      (key) =>
        key.startsWith('vnp_') &&
        key !== 'vnp_SecureHash' &&
        key !== 'vnp_SecureHashType',
    )
    .sort()
    .map((key) => `${key}=${encode(receipt[key])}`)
    .join('&');
  const expected = createHmac('sha512', options.hashSecret)
    .update(data)
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(receipt.vnp_SecureHash, 'hex')))
    return;
  return {
    responseCode: receipt.vnp_ResponseCode,
    transactionNo: receipt.vnp_TransactionNo,
    source: 'verified-failure-ipn',
  };
}

/** Operator evidence captured from the authenticated Sandbox portal, NOT an IPN.
 * Only reconcile already-paid Orders; never invent an IPN or reassign a payment.
 */
function confirmedPortalSuccess(
  intent: Intent,
  orders: Order[],
  options: MigrationOptions,
): Resolution | undefined {
  const evidence = options.portalEvidence;
  if (
    !evidence ||
    evidence.source !== 'vnpay-sandbox-merchant-portal' ||
    !Number.isFinite(Date.parse(evidence.capturedAt)) ||
    !Array.isArray(evidence.payments) ||
    !options.tmnCode ||
    intent.ipnConfirmed === true ||
    (intent.responseCode && intent.responseCode !== '00') ||
    !orders.length ||
    orders.some((o) => o.status !== 'Paid' || !(o.paidAt instanceof Date))
  )
    return;
  const matches = evidence.payments.filter((p) => p.txnRef === intent.txnRef);
  if (matches.length !== 1) return;
  const p = matches[0];
  let paymentUrl: URL;
  try {
    paymentUrl = new URL(String(intent.paymentUrl));
  } catch {
    return;
  }
  const completedAt = new Date(p.confirmedAt);
  if (
    paymentUrl.origin !== 'https://sandbox.vnpayment.vn' ||
    paymentUrl.searchParams.get('vnp_TmnCode') !== options.tmnCode ||
    paymentUrl.searchParams.get('vnp_TxnRef') !== intent.txnRef ||
    Number(paymentUrl.searchParams.get('vnp_Amount')) !== intent.amount * 100 ||
    p.tmnCode !== options.tmnCode ||
    p.amount !== intent.amount ||
    p.currency !== 'VND' ||
    p.status !== 'succeeded' ||
    p.responseCode !== '00' ||
    !/^[1-9]\d*$/.test(p.transactionNo) ||
    (intent.transactionNo && intent.transactionNo !== p.transactionNo) ||
    p.sourceUrl !==
      `https://sandbox.vnpayment.vn/merchantv2/Transaction/PaymentDetail/${p.transactionNo}.htm` ||
    !Number.isFinite(completedAt.getTime()) ||
    !(intent.createdAt instanceof Date) ||
    completedAt < intent.createdAt ||
    completedAt.getTime() > Date.parse(evidence.capturedAt) ||
    (options.receipts ?? []).some((r) => r.vnp_TxnRef === intent.txnRef)
  )
    return;
  return {
    status: 'succeeded',
    responseCode: '00',
    transactionNo: p.transactionNo,
    completedAt,
    source: 'operator-verified-sandbox-portal',
  };
}

function planMigration(before: Snapshot, options: MigrationOptions) {
  const updates: { intent: Intent; resolution: Resolution }[] = [];
  const ambiguous: string[] = [];
  for (const group of before.groups) {
    const intents = before.intents.filter(
      (i) => i.sessionId.equals(group._id) && unresolved(i),
    );
    const safe: typeof updates = [];
    for (const intent of intents) {
      const failure = confirmedFailure(intent, options);
      const orders = before.orders.filter((o) =>
        intent.coveredOrderIds?.some((id) => id.equals(o._id)),
      );
      const success = confirmedPortalSuccess(intent, orders, options);
      const completeSnapshot =
        !!intent.coveredOrderIds?.length &&
        orders.length === intent.coveredOrderIds.length &&
        orders.every(
          (o) => Number.isSafeInteger(o.totalAmount) && o.totalAmount >= 0,
        ) &&
        orders.reduce((sum, o) => sum + o.totalAmount, 0) === intent.amount;
      const conflictingSuccess =
        failure &&
        before.intents.some(
          (i) =>
            i.status === 'succeeded' &&
            (i.txnRef === intent.txnRef ||
              (!/^0+$/.test(failure.transactionNo) &&
                i.transactionNo === failure.transactionNo)),
        );
      const paidByThisTransaction =
        failure &&
        !/^0+$/.test(failure.transactionNo) &&
        orders.some((o) =>
          o.statusHistory?.some(
            (h) =>
              h.toStatus === 'Paid' &&
              h.transactionNo === failure.transactionNo,
          ),
        );
      if (
        failure &&
        completeSnapshot &&
        !conflictingSuccess &&
        !paidByThisTransaction
      )
        safe.push({ intent, resolution: { ...failure, status: 'failed' } });
      else if (
        success &&
        completeSnapshot &&
        !before.intents.some(
          (i) =>
            i.txnRef !== intent.txnRef &&
            i.transactionNo === success.transactionNo,
        ) &&
        options.portalEvidence?.payments.filter(
          (p) => p.transactionNo === success.transactionNo,
        ).length === 1
      )
        safe.push({ intent, resolution: success });
    }
    if (intents.length - safe.length > (options.portalEvidence ? 0 : 1))
      ambiguous.push(String(group._id));
    else updates.push(...safe);
  }
  return { updates, ambiguous };
}

async function backup(
  db: mongo.Db,
  before: Snapshot,
  directory: string,
  portalEvidence?: PortalEvidence,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = resolve(
    directory,
    `payment-intent-migration-backup-${randomUUID()}.json`,
  );
  const data = serialize({
    version: 1,
    database: db.databaseName,
    capturedAt: new Date(),
    ...(portalEvidence
      ? { portalEvidence, evidenceSha256: digest(portalEvidence) }
      : {}),
    ...before,
  });
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(data, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  if ((await readFile(path, 'utf8')) !== data)
    throw new Error('Backup verification failed; no writes allowed');
  return path;
}

async function duplicateOrders(db: mongo.Db, session?: mongo.ClientSession) {
  return db
    .collection(COLLECTION)
    .aggregate<Group>(
      [
        { $match: UNRESOLVED_PAYMENT_FILTER },
        { $unwind: '$coveredOrderIds' },
        { $group: { _id: '$coveredOrderIds', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ],
      { session },
    )
    .toArray();
}

export async function migratePaymentIntents(
  client: mongo.MongoClient,
  db: mongo.Db,
  options: MigrationOptions,
) {
  const log = options.log ?? (() => undefined);
  // Native collections deliberately avoid Mongoose autoIndex before reconciliation.
  const before = await snapshot(db);
  const plan = planMigration(before, options);
  // Also back up ambiguous groups for manual reconciliation; no secrets/config are exported.
  const backupPath = before.groups.length
    ? await backup(db, before, options.backupDirectory, options.portalEvidence)
    : undefined;
  const report = {
    mode: options.apply ? 'apply' : 'dry-run',
    database: db.databaseName,
    conflictSessions: before.groups.length,
    conflictDocuments: before.groups.reduce((n, g) => n + g.count, 0),
    conflictOrders: (await duplicateOrders(db)).length,
    documentsToUpdate: plan.updates.length,
    ambiguousSessions: plan.ambiguous,
    backupPath,
    portalEvidenceSha256: options.portalEvidence
      ? digest(options.portalEvidence)
      : undefined,
  };
  log(report);
  for (const intent of before.intents) {
    const update = plan.updates.find((u) => u.intent._id.equals(intent._id));
    log({
      sessionId: String(intent.sessionId),
      txnRef: intent.txnRef,
      status: intent.status,
      ipnConfirmed: intent.ipnConfirmed ?? null,
      expiresAt: intent.expiresAt,
      createdAt: intent.createdAt,
      coveredOrderIds: intent.coveredOrderIds?.map(String),
      action: update
        ? `resolve-confirmed-${update.resolution.status}`
        : 'preserve',
      resolution: update?.resolution,
      existingPaidTransactionNos: before.orders
        .filter((o) => intent.coveredOrderIds?.some((id) => id.equals(o._id)))
        .flatMap(
          (o) =>
            o.statusHistory
              ?.filter((h) => h.toStatus === 'Paid')
              .map((h) => h.transactionNo) ?? [],
        ),
    });
  }
  if (!options.apply) return report;
  if (plan.ambiguous.length)
    throw new Error(
      `Manual reconciliation required for sessions: ${plan.ambiguous.join(', ')}; no database writes performed`,
    );
  // The narrow portal path changes only fully-settled intents whose Orders are
  // already Paid. Transaction snapshot/CAS protects against concurrent IPNs;
  // no checkout, Order, or session state is changed. Index failures stay fatal.
  const settledPortalOnly =
    !!options.portalEvidence &&
    plan.updates.length === report.conflictDocuments &&
    plan.updates.every((u) => u.resolution.status === 'succeeded');
  if (!options.writesPaused && !settledPortalOnly)
    throw new Error(
      'Apply requires --writes-paused: stop checkout/IPN writers until index verification finishes',
    );
  const session = client.startSession();
  try {
    await session.withTransaction(
      async () => {
        const current = await snapshot(db, session);
        // Abort if any full document (including financial history) changed since the backup.
        if (digest(current) !== digest(before))
          throw new Error('Database changed after backup; rerun dry-run');
        for (const { intent, resolution } of plan.updates) {
          if (
            resolution.status === 'succeeded' &&
            (await db.collection<Intent>(COLLECTION).findOne(
              {
                _id: { $ne: intent._id },
                transactionNo: resolution.transactionNo,
              },
              { session },
            ))
          )
            throw new Error(
              'Provider transaction belongs to another intent; transaction aborted',
            );
          const result = await db.collection<Intent>(COLLECTION).updateOne(
            {
              _id: intent._id,
              ...UNRESOLVED_PAYMENT_FILTER,
            },
            {
              $set: {
                status: resolution.status,
                ...(resolution.status === 'failed'
                  ? { ipnConfirmed: true }
                  : {}),
                responseCode: resolution.responseCode,
                transactionNo: resolution.transactionNo,
                completedAt:
                  resolution.completedAt ?? intent.completedAt ?? new Date(),
              },
            },
            { session },
          );
          if (result.modifiedCount !== 1)
            throw new Error(
              'Payment changed concurrently; transaction aborted',
            );
        }
        if ((await snapshot(db, session)).groups.length)
          throw new Error('Unresolved duplicates remain; transaction aborted');
        if ((await duplicateOrders(db, session)).length)
          throw new Error(
            'Unresolved order duplicates remain; transaction aborted',
          );
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
  } finally {
    await session.endSession();
  }

  // Additive only, including per-order reservation: boot must satisfy ALL schema indexes.
  for (const [keys, indexOptions] of PaymentIntentSchema.indexes()) {
    await db
      .collection(COLLECTION)
      .createIndex(
        keys as mongo.IndexSpecification,
        indexOptions as mongo.CreateIndexesOptions,
      );
  }
  const indexes = await db.collection(COLLECTION).indexes();
  for (const [name, key] of [
    [SESSION_INDEX, { sessionId: 1 }],
    [ORDER_INDEX, { coveredOrderIds: 1 }],
  ] as const) {
    const index = indexes.find((i) => i.name === name);
    if (
      !index?.unique ||
      !isDeepStrictEqual(index.key, key) ||
      !isDeepStrictEqual(
        index.partialFilterExpression,
        UNRESOLVED_PAYMENT_FILTER,
      )
    )
      throw new Error(`Unique partial index verification failed: ${name}`);
  }
  const unchanged = before.intents.filter(
    (i) => !plan.updates.some((u) => u.intent._id.equals(i._id)),
  );
  const preserved = await db
    .collection<Intent>(COLLECTION)
    .find({ _id: { $in: unchanged.map((i) => i._id) } })
    .sort({ _id: 1 })
    .toArray();
  const orders = await db
    .collection<Order>('orders')
    .find({ _id: { $in: before.orders.map((o) => o._id) } })
    .sort({ _id: 1 })
    .toArray();
  if (
    digest(unchanged) !== digest(preserved) ||
    digest(before.orders) !== digest(orders)
  )
    throw new Error('History verification failed; stop and inspect backup');
  if ((await snapshot(db)).groups.length)
    throw new Error('Concurrent unresolved duplicates detected');
  if ((await duplicateOrders(db)).length)
    throw new Error('Concurrent unresolved order duplicates detected');
  log({
    verified: true,
    duplicateUnresolvedSessions: 0,
    duplicateUnresolvedOrders: 0,
    indexes: [SESSION_INDEX, ORDER_INDEX],
    unique: true,
    partial: true,
    ordersAndPreservedIntentsUnchanged: true,
  });
  return report;
}

export function assertDeploymentTarget(
  uri: string,
  expectedHost: string,
  expectedDb: string,
  environment: string,
) {
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    throw new Error('Invalid MongoDB configuration (URI redacted)');
  }
  if (
    !['production', 'demo'].includes(environment) ||
    !expectedHost ||
    !expectedDb ||
    !['mongodb:', 'mongodb+srv:'].includes(target.protocol) ||
    target.hostname !== expectedHost ||
    decodeURIComponent(target.pathname.slice(1)) !== expectedDb ||
    /^(admin|local|config|test)$/i.test(expectedDb) ||
    /(^|[_-])(test|dev)([_-]|$)/i.test(expectedDb)
  ) {
    throw new Error(
      'Deployment target mismatch; explicitly confirm deployment, expected host and database',
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      apply: { type: 'boolean' },
      'writes-paused': { type: 'boolean' },
      'env-file': { type: 'string' },
      'expected-host': { type: 'string' },
      'expected-db': { type: 'string' },
      deployment: { type: 'string' },
      'ipn-evidence': { type: 'string' },
      'portal-evidence': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(
      'Dry-run: npm run migrate:payment-intents -- --env-file <deployment.env> --deployment production|demo --expected-host <host> --expected-db <database> [--ipn-evidence <signed-failure-ipns.json>] [--portal-evidence <operator-verified-sandbox-success.json>]',
    );
    console.log(
      'Apply: same arguments plus --apply --writes-paused. Backups: backend/tmp/ (gitignored). Never infer failure from expiry or another successful checkout.',
    );
    return;
  }
  // No implicit .env fallback: an operator must select the deployment configuration.
  const env = values['env-file']
    ? parse(await readFile(values['env-file']))
    : process.env;
  assertDeploymentTarget(
    env.MONGODB_URI ?? '',
    values['expected-host'] ?? '',
    values['expected-db'] ?? '',
    values.deployment ?? '',
  );
  if (env.CUSTOM_DNS_SERVERS) setServers(env.CUSTOM_DNS_SERVERS.split(','));
  const receipts: unknown = values['ipn-evidence']
    ? JSON.parse(await readFile(values['ipn-evidence'], 'utf8'))
    : [];
  if (
    !Array.isArray(receipts) ||
    receipts.some(
      (r: unknown) =>
        !r ||
        typeof r !== 'object' ||
        Array.isArray(r) ||
        Object.values(r).some((v) => typeof v !== 'string'),
    )
  )
    throw new Error(
      'IPN evidence must be an array of original signed callback parameter objects',
    );
  const client = new mongo.MongoClient(env.MONGODB_URI!, {
    serverSelectionTimeoutMS: 15000,
  });
  try {
    await client.connect();
    const db = client.db(values['expected-db']);
    const names = (
      await db.listCollections({}, { nameOnly: true }).toArray()
    ).map((c) => c.name);
    if (
      !['payment_intents', 'orders', 'sessions'].every((name) =>
        names.includes(name),
      )
    )
      throw new Error('Expected deployment collections are missing');
    const report = await migratePaymentIntents(client, db, {
      apply: values.apply,
      writesPaused: values['writes-paused'],
      backupDirectory: resolve(__dirname, '../tmp'),
      receipts: receipts as Receipt[],
      portalEvidence: values['portal-evidence']
        ? (JSON.parse(
            await readFile(values['portal-evidence'], 'utf8'),
          ) as PortalEvidence)
        : undefined,
      tmnCode: env.VNP_TMN_CODE,
      hashSecret: env.VNP_HASH_SECRET,
      log: (record) => console.log(JSON.stringify(record)),
    });
    if (report.ambiguousSessions.length) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    // Driver/parse errors can embed a connection string or document: print no raw details.
    const code =
      error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    const message =
      error instanceof Error && error.constructor === Error
        ? error.message
        : 'Migration failed; inspect connectivity/indexes and the dry-run report (sensitive details redacted)';
    console.error(
      JSON.stringify({
        message,
        ...(typeof code === 'number' ? { code } : {}),
      }),
    );
    process.exitCode = 1;
  });
