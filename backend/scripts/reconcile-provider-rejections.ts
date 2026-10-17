/** Explicit, evidence-gated CLI. No HTTP endpoint or application-startup import. */
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { setServers } from 'node:dns';
import { mkdir, open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { parse } from 'dotenv';
import { mongo } from 'mongoose';
import { assertDeploymentTarget } from './migrate-payment-intents';
import {
  PaymentIntentStatus,
  UNRESOLVED_PAYMENT_FILTER,
} from '../src/modules/vnpay/payment-intent.schema';

export type ProviderRejectionEvidence = {
  source: 'operator-verified-vnpay-sandbox-portal';
  confirmedAt: string;
  operatorNote: string;
  tmnCode: string;
  merchantWebsite: string;
  smartOrderWebsite: string;
  returnUrl: string;
  portalUrl: string;
  searchDate: string;
  gatewayCode: '71';
  payments: {
    txnRef: string;
    sessionId: string;
    amount: number;
    coveredOrderIds: string[];
    createDate: string;
    portalResult: 'not_found';
  }[];
};

type Options = {
  apply?: boolean;
  backupDirectory: string;
  tmnCode: string;
  hashSecret: string;
  evidence: ProviderRejectionEvidence;
};
const collection = 'payment_intents';
const serialize = (value: unknown) =>
  mongo.BSON.EJSON.stringify(value, { relaxed: false });
const digest = (value: unknown) =>
  createHash('sha256').update(serialize(value)).digest('hex');

function validateEvidence(e: ProviderRejectionEvidence, tmnCode: string) {
  if (
    e.source !== 'operator-verified-vnpay-sandbox-portal' ||
    e.gatewayCode !== '71' ||
    e.tmnCode !== tmnCode ||
    !/^[A-Za-z0-9]{8}$/.test(tmnCode) ||
    !e.merchantWebsite?.trim() ||
    !e.operatorNote?.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(e.searchDate) ||
    !Number.isFinite(Date.parse(e.confirmedAt)) ||
    Date.parse(e.confirmedAt) > Date.now() ||
    !Array.isArray(e.payments) ||
    !e.payments.length ||
    e.payments.length > 10 ||
    new Set(e.payments.map((p) => p.txnRef)).size !== e.payments.length
  )
    throw new Error(
      'Incomplete or mismatched operator reconciliation evidence',
    );
  const portal = new URL(e.portalUrl);
  if (
    portal.origin !== 'https://sandbox.vnpayment.vn' ||
    !portal.pathname.startsWith('/merchantv2/') ||
    portal.username ||
    portal.password ||
    new URL(e.smartOrderWebsite).protocol !== 'https:' ||
    new URL(e.returnUrl).protocol !== 'https:'
  )
    throw new Error(
      'Expected Sandbox merchant portal and HTTPS application URLs',
    );
  for (const p of e.payments) {
    if (
      p.portalResult !== 'not_found' ||
      !/^[a-zA-Z0-9]{1,100}$/.test(p.txnRef) ||
      !/^[a-f0-9]{24}$/.test(p.sessionId) ||
      !Number.isSafeInteger(p.amount * 100) ||
      p.amount <= 0 ||
      !/^\d{14}$/.test(p.createDate) ||
      p.createDate.slice(0, 8) !== e.searchDate.replaceAll('-', '') ||
      !Array.isArray(p.coveredOrderIds) ||
      !p.coveredOrderIds.length ||
      new Set(p.coveredOrderIds).size !== p.coveredOrderIds.length ||
      p.coveredOrderIds.some((id) => !/^[a-f0-9]{24}$/.test(id))
    )
      throw new Error(
        'Evidence must identify each original checkout and portal search',
      );
  }
}

async function verifyIndexes(db: mongo.Db) {
  const indexes = await db.collection(collection).listIndexes().toArray();
  for (const [name, key] of [
    ['one_unresolved_checkout_per_session', { sessionId: 1 }],
    ['one_unresolved_checkout_per_order', { coveredOrderIds: 1 }],
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
      throw new Error(
        'Required unique unresolved index is missing or mismatched',
      );
  }
  return indexes;
}

async function snapshot(
  db: mongo.Db,
  e: ProviderRejectionEvidence,
  session?: mongo.ClientSession,
) {
  const sessionIds = e.payments.map((p) => new mongo.ObjectId(p.sessionId));
  const orderIds = e.payments.flatMap((p) =>
    p.coveredOrderIds.map((id) => new mongo.ObjectId(id)),
  );
  const intents = await db
    .collection(collection)
    .find(
      {
        $or: [
          { sessionId: { $in: sessionIds } },
          { txnRef: { $in: e.payments.map((p) => p.txnRef) } },
        ],
      },
      { session },
    )
    .sort({ _id: 1 })
    .toArray();
  const orders = await db
    .collection('orders')
    .find(
      { $or: [{ sessionId: { $in: sessionIds } }, { _id: { $in: orderIds } }] },
      { session },
    )
    .sort({ _id: 1 })
    .toArray();
  return { intents, orders };
}

function plan(before: Awaited<ReturnType<typeof snapshot>>, options: Options) {
  const { evidence: e } = options;
  const evidenceSha256 = digest(e);
  return e.payments.flatMap((p) => {
    const matches = before.intents.filter((i) => i.txnRef === p.txnRef);
    if (matches.length !== 1)
      throw new Error('Checkout is missing or duplicated');
    const i = matches[0];
    if (
      i.status === PaymentIntentStatus.PROVIDER_REJECTED &&
      i.resolutionSource === 'reconciliation' &&
      i.reconciliationEvidenceSha256 === evidenceSha256 &&
      i.providerCode === '71' &&
      i.ipnConfirmed !== true
    )
      return [];
    if (
      !['pending', 'failed'].includes(i.status) ||
      i.ipnConfirmed === true ||
      i.responseCode === '00' ||
      (i.transactionNo && !/^0+$/.test(i.transactionNo)) ||
      i.paymentMethod === 'internal_zero' ||
      i.resolutionSource ||
      !(i.createdAt instanceof Date) ||
      !(i.expiresAt instanceof Date) ||
      Date.parse(e.confirmedAt) < i.expiresAt.getTime() ||
      String(i.sessionId) !== p.sessionId ||
      i.amount !== p.amount ||
      !isDeepStrictEqual(
        i.coveredOrderIds?.map(String).sort(),
        [...p.coveredOrderIds].sort(),
      )
    )
      throw new Error(
        'Checkout is not an expired unresolved match or has conflicting evidence',
      );
    const url = new URL(i.paymentUrl);
    const params = url.searchParams;
    const originalDate = new Date(i.createdAt.getTime() + 7 * 3600000)
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14);
    const confirmedDate = new Date(Date.parse(e.confirmedAt) + 7 * 3600000)
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14);
    const originalExpiry = params.get('vnp_ExpireDate') ?? '';
    const hash = params.get('vnp_SecureHash') ?? '';
    const data = [...params.entries()]
      .filter(
        ([k]) =>
          k.startsWith('vnp_') &&
          k !== 'vnp_SecureHash' &&
          k !== 'vnp_SecureHashType',
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%20/g, '+')}`)
      .join('&');
    if (
      !options.hashSecret ||
      !/^[a-fA-F0-9]{128}$/.test(hash) ||
      !timingSafeEqual(
        createHmac('sha512', options.hashSecret).update(data).digest(),
        Buffer.from(hash, 'hex'),
      ) ||
      url.origin !== 'https://sandbox.vnpayment.vn' ||
      url.pathname !== '/paymentv2/vpcpay.html' ||
      params.get('vnp_TmnCode') !== e.tmnCode ||
      params.get('vnp_TxnRef') !== p.txnRef ||
      params.get('vnp_Amount') !== String(p.amount * 100) ||
      params.get('vnp_CurrCode') !== 'VND' ||
      params.get('vnp_CreateDate') !== p.createDate ||
      originalDate !== p.createDate ||
      !/^\d{14}$/.test(originalExpiry) ||
      originalExpiry < p.createDate ||
      originalExpiry > confirmedDate ||
      params.get('vnp_ReturnUrl') !== e.returnUrl
    )
      throw new Error(
        'Original signed checkout does not match reconciliation evidence',
      );
    const orders = before.orders.filter((o) =>
      p.coveredOrderIds.includes(String(o._id)),
    );
    if (
      orders.length !== p.coveredOrderIds.length ||
      orders.some(
        (o) =>
          o.status !== 'Served' ||
          o.paidAt ||
          o.statusHistory?.some(
            (h: { toStatus: string }) => h.toStatus === 'Paid',
          ) ||
          String(o.sessionId) !== p.sessionId ||
          !Number.isSafeInteger(o.totalAmount),
      ) ||
      orders.reduce((sum, o) => sum + o.totalAmount, 0) !== p.amount ||
      before.intents.some(
        (other) =>
          other.status === 'succeeded' &&
          other.coveredOrderIds?.some((id: mongo.ObjectId) =>
            p.coveredOrderIds.includes(String(id)),
          ),
      )
    )
      throw new Error(
        'Order snapshot changed or conflicts with settled payment history',
      );
    return [i];
  });
}

export async function reconcileProviderRejections(
  client: mongo.MongoClient,
  db: mongo.Db,
  options: Options,
) {
  validateEvidence(options.evidence, options.tmnCode);
  const indexes = await verifyIndexes(db);
  const before = await snapshot(db, options.evidence);
  const updates = plan(before, options);
  const evidenceSha256 = digest(options.evidence);
  const resolvedAt = new Date();
  const payload = {
    capturedAt: resolvedAt,
    database: db.databaseName,
    evidence: options.evidence,
    evidenceSha256,
    ...before,
    indexes,
  };
  await mkdir(options.backupDirectory, { recursive: true });
  const backupPath = resolve(
    options.backupDirectory,
    `provider-rejection-backup-${randomUUID()}.json`,
  );
  const file = await open(backupPath, 'wx', 0o600);
  try {
    await file.writeFile(serialize(payload));
    await file.sync();
  } finally {
    await file.close();
  }
  if ((await readFile(backupPath, 'utf8')) !== serialize(payload))
    throw new Error('Backup verification failed; no database changes made');
  const fields = {
    status: PaymentIntentStatus.PROVIDER_REJECTED,
    resolutionSource: 'reconciliation',
    providerCode: '71',
    resolutionReason: 'terminal_not_approved',
    resolvedAt,
    completedAt: resolvedAt,
    updatedAt: resolvedAt,
    reconciliationNote: options.evidence.operatorNote,
    reconciliationEvidenceSha256: evidenceSha256,
  };
  if (options.apply && updates.length) {
    const session = client.startSession();
    try {
      await session.withTransaction(
        async () => {
          const current = await snapshot(db, options.evidence, session);
          if (serialize(current) !== serialize(before))
            throw new Error('Data changed after backup; rerun reconciliation');
          for (const intent of updates) {
            const result = await db
              .collection(collection)
              .updateOne(
                { _id: intent._id, ...UNRESOLVED_PAYMENT_FILTER },
                { $set: fields },
                { session },
              );
            if (result.modifiedCount !== 1)
              throw new Error('Conditional reconciliation update failed');
          }
          const after = await snapshot(db, options.evidence, session);
          const expected = {
            ...before,
            intents: before.intents.map((i) =>
              updates.some((u) => u._id.equals(i._id))
                ? { ...i, ...fields }
                : i,
            ),
          };
          // MongoDB may append $set fields in lexicographic order; field order
          // is not a history change. Compare BSON values and all fields instead.
          if (!isDeepStrictEqual(after, expected))
            throw new Error(
              'History or Order preservation verification failed',
            );
          if (
            await db.collection(collection).countDocuments(
              {
                txnRef: { $in: options.evidence.payments.map((p) => p.txnRef) },
                ...UNRESOLVED_PAYMENT_FILTER,
              },
              { session },
            )
          )
            throw new Error(
              'Reconciled checkout still matches unresolved filter',
            );
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } finally {
      await session.endSession();
    }
  }
  if (!isDeepStrictEqual(await verifyIndexes(db), indexes))
    throw new Error(
      'Index definitions changed concurrently; inspect preserved backup',
    );
  return {
    mode: options.apply ? 'apply' : 'dry-run',
    txnRefs: updates.map((i) => i.txnRef),
    documentsToUpdate: updates.length,
    backupPath,
    evidenceSha256,
    ordersWritten: 0,
    ipnConfirmedWritten: false,
    indexChanges: 0,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      apply: { type: 'boolean' },
      'env-file': { type: 'string' },
      'expected-host': { type: 'string' },
      'expected-db': { type: 'string' },
      deployment: { type: 'string' },
      evidence: { type: 'string' },
    },
  });
  const env = values['env-file']
    ? parse(await readFile(values['env-file']))
    : process.env;
  assertDeploymentTarget(
    env.MONGODB_URI ?? '',
    values['expected-host'] ?? '',
    values['expected-db'] ?? '',
    values.deployment ?? '',
  );
  const evidence = JSON.parse(
    await readFile(values.evidence ?? '', 'utf8'),
  ) as ProviderRejectionEvidence;
  if (env.CUSTOM_DNS_SERVERS) setServers(env.CUSTOM_DNS_SERVERS.split(','));
  const client = new mongo.MongoClient(env.MONGODB_URI!, {
    serverSelectionTimeoutMS: 15000,
  });
  try {
    await client.connect();
    console.log(
      JSON.stringify(
        await reconcileProviderRejections(
          client,
          client.db(values['expected-db']),
          {
            apply: values.apply,
            backupDirectory: resolve(__dirname, '../tmp'),
            tmnCode: env.VNP_TMN_CODE?.trim() ?? '',
            hashSecret: env.VNP_HASH_SECRET?.trim() ?? '',
            evidence,
          },
        ),
      ),
    );
  } finally {
    await client.close();
  }
}
if (require.main === module)
  void main().catch(() => {
    console.error(
      'Reconciliation stopped; target/evidence/data/index checks failed. Sensitive details redacted.',
    );
    process.exitCode = 1;
  });
