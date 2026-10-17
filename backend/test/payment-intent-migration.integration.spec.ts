import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { mongo } from 'mongoose';
import {
  assertDeploymentTarget,
  migratePaymentIntents,
  SESSION_INDEX,
  ORDER_INDEX,
  PortalEvidence,
} from '../scripts/migrate-payment-intents';
import { UNRESOLVED_PAYMENT_FILTER } from '../src/modules/vnpay/payment-intent.schema';
import { VnpayService } from '../src/modules/vnpay/vnpay.service';
import { testMongoUri } from './support/test-database';
import {
  assessQueryResponse,
  queryProvider,
  queryRequest,
} from '../scripts/query-payment-intents';

describe('VNPAY QueryDr reconciliation', () => {
  const config = {
    tmnCode: 'TESTCODE',
    hashSecret: 'query-test-only-secret',
    ipAddress: '127.0.0.1',
  };
  const target = {
    txnRef: 'legacy1',
    amount: 10000,
    transactionDate: '20260911004837',
  };
  function providerReply(code = '00', state = '02') {
    const reply = {
      vnp_ResponseId: 'response1',
      vnp_Command: 'querydr',
      vnp_ResponseCode: code,
      vnp_Message: 'Query result',
      vnp_TmnCode: 'TESTCODE',
      vnp_TxnRef: 'legacy1',
      vnp_Amount: '1000000',
      vnp_BankCode: 'NCB',
      vnp_PayDate: '',
      vnp_TransactionNo: '123',
      vnp_TransactionType: '01',
      vnp_TransactionStatus: state,
      vnp_OrderInfo: 'Original payment',
      vnp_PromotionCode: '',
      vnp_PromotionAmount: '',
      vnp_SecureHash: '',
    };
    // Independent fixed wire-format fixture from the published QueryDr field order.
    reply.vnp_SecureHash = createHmac('sha512', config.hashSecret)
      .update(
        `response1|querydr|${code}|Query result|TESTCODE|legacy1|1000000|NCB||123|01|${state}|Original payment||`,
      )
      .digest('hex');
    return reply;
  }

  it('signs the QueryDr request using the original payment date and GMT+7 request time', () => {
    const request = queryRequest(
      target,
      config,
      new Date('2026-10-12T18:00:00Z'),
    );
    expect(request.vnp_RequestId).toMatch(/^[a-f0-9]{32}$/);
    expect(request.vnp_CreateDate).toBe('20261013010000');
    expect(request.vnp_TransactionDate).toBe('20260911004837');
    const expected = createHmac('sha512', config.hashSecret)
      .update(
        `${request.vnp_RequestId}|2.1.0|querydr|TESTCODE|legacy1|20260911004837|20261013010000|127.0.0.1|Reconcile legacy1`,
      )
      .digest('hex');
    expect(request.vnp_SecureHash).toBe(expected);
  });

  it('requires a signed, matching terminal payment result; not-found and unfinished remain unknown', () => {
    expect(assessQueryResponse(providerReply(), target, config)).toMatchObject({
      category: 'B_FAILED',
      signatureValid: true,
    });
    expect(
      assessQueryResponse(providerReply('00', '00'), target, config),
    ).toMatchObject({ category: 'A_SUCCESS', signatureValid: true });
    expect(
      assessQueryResponse(providerReply('91'), target, config),
    ).toMatchObject({
      category: 'C_UNKNOWN',
      reason: 'transaction-not-found',
      signatureValid: true,
    });
    expect(
      assessQueryResponse(providerReply('00', '01'), target, config),
    ).toMatchObject({ category: 'C_UNKNOWN', signatureValid: true });
    expect(
      assessQueryResponse(providerReply('97'), target, config),
    ).toMatchObject({ category: 'D_ERROR', signatureValid: true });
    expect(
      assessQueryResponse(
        { ...providerReply(), vnp_SecureHash: '' },
        target,
        config,
      ),
    ).toMatchObject({ category: 'C_UNKNOWN', signatureValid: false });
    expect(
      assessQueryResponse(
        { ...providerReply(), vnp_TransactionStatus: '00' },
        target,
        config,
      ),
    ).toMatchObject({ category: 'C_UNKNOWN', reason: 'signature-mismatch' });
    expect(
      assessQueryResponse(
        providerReply(),
        { ...target, txnRef: 'different' },
        config,
      ),
    ).toMatchObject({
      category: 'C_UNKNOWN',
      reason: 'response-identity-mismatch',
    });
    expect(
      assessQueryResponse(providerReply(), { ...target, amount: 1 }, config),
    ).toMatchObject({
      category: 'C_UNKNOWN',
      reason: 'payment-identity-or-amount-mismatch',
    });
  });

  it('classifies provider/network failures without inventing a failed payment', async () => {
    const endpoint = 'https://example.invalid/query';
    const fetcher = jest
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('private network details'));
    expect(
      (await queryProvider(target, config, endpoint, fetcher)).assessment,
    ).toMatchObject({ category: 'D_ERROR', signatureValid: false });
  });
});

describe('Payment intent migration (owned replica set only)', () => {
  let client: mongo.MongoClient;
  let db: mongo.Db;
  const fixtureIds: mongo.ObjectId[] = [];
  const backups: string[] = [];
  const backupDirectory = resolve(
    'tmp',
    `payment-migration-test-${randomUUID()}`,
  );
  const hashSecret = 'isolated-migration-test-secret';
  const tmnCode = 'TESTCODE';
  const options = { backupDirectory, hashSecret, tmnCode };

  beforeAll(async () => {
    client = await new mongo.MongoClient(testMongoUri()).connect();
    db = client.db();
    await mkdir(backupDirectory, { recursive: true });
  });
  afterEach(async () => {
    for (const name of ['payment_intents', 'orders']) {
      await db.collection(name).deleteMany({ _id: { $in: fixtureIds } });
    }
    fixtureIds.length = 0;
    // Only the owned ephemeral test database: each case tests creating indexes.
    await db.collection('payment_intents').dropIndexes();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await client.close();
    for (const file of backups) await unlink(file);
    await rmdir(backupDirectory);
  });
  const log = (record: unknown) => {
    const path = (record as { backupPath?: string }).backupPath;
    if (path) backups.push(path);
  };
  async function fixture(status = 'pending', sessionId = new mongo.ObjectId()) {
    const _id = new mongo.ObjectId();
    const order = {
      _id: new mongo.ObjectId(),
      sessionId,
      status: 'Served',
      totalAmount: 10000,
    };
    const intent = {
      _id,
      sessionId,
      txnRef: _id.toHexString(),
      status,
      amount: order.totalAmount,
      coveredOrderIds: [order._id],
      coverageKey: `${String(sessionId)}:${String(order._id)}`,
      createdAt: new Date('2026-01-01'),
      expiresAt: new Date('2026-01-01T00:15:00Z'),
      paymentUrl: `https://sandbox.vnpayment.vn/paymentv2/vpcpay.html?vnp_TmnCode=${tmnCode}&vnp_TxnRef=${String(_id)}&vnp_Amount=1000000`,
      invoiceCode: `legacy-${String(_id)}`,
    };
    fixtureIds.push(_id, order._id);
    await db.collection('orders').insertOne(order);
    await db.collection('payment_intents').insertOne(intent);
    return { intent, order };
  }
  function signedFailure(txnRef: string): Record<string, string> {
    const receipt: Record<string, string> = {
      vnp_TmnCode: tmnCode,
      vnp_TxnRef: txnRef,
      vnp_Amount: '1000000',
      vnp_ResponseCode: '24',
      vnp_TransactionStatus: '02',
      vnp_TransactionNo: '0',
    };
    const data = Object.keys(receipt)
      .sort()
      .map(
        (key) =>
          `${key}=${encodeURIComponent(receipt[key]).replace(/%20/g, '+')}`,
      )
      .join('&');
    receipt.vnp_SecureHash = createHmac('sha512', hashSecret)
      .update(data)
      .digest('hex');
    return receipt;
  }

  it('backs up and refuses expired/superseded checkouts without authenticated failure evidence', async () => {
    const old = await fixture();
    await fixture('failed', old.intent.sessionId);
    const succeeded = await fixture('succeeded', old.intent.sessionId);
    await db.collection('orders').updateOne(
      { _id: old.order._id },
      {
        $set: {
          status: 'Paid',
          paidAt: new Date(),
          statusHistory: [{ toStatus: 'Paid', transactionNo: '123' }],
        },
      },
    );
    await db.collection('payment_intents').updateOne(
      { _id: succeeded.intent._id },
      {
        $set: { transactionNo: '123', responseCode: '00' },
      },
    );
    const before = await db
      .collection('payment_intents')
      .find()
      .sort({ _id: 1 })
      .toArray();
    const tampered = signedFailure(old.intent.txnRef);
    tampered.vnp_Amount = '1';
    const report = await migratePaymentIntents(client, db, {
      ...options,
      receipts: [tampered],
      log,
    });
    expect(report).toMatchObject({
      conflictSessions: 1,
      conflictDocuments: 2,
      documentsToUpdate: 0,
      ambiguousSessions: [old.intent.sessionId.toString()],
    });
    const saved = mongo.BSON.EJSON.parse(
      await readFile(report.backupPath!, 'utf8'),
    ) as { intents: unknown[] };
    expect(saved.intents).toEqual(before);
    await expect(
      migratePaymentIntents(client, db, {
        ...options,
        apply: true,
        writesPaused: true,
        log,
      }),
    ).rejects.toThrow('Manual reconciliation');
    expect(
      await db.collection('payment_intents').find().sort({ _id: 1 }).toArray(),
    ).toEqual(before);
  });

  it('resolves a verified legacy failure, preserves financial history, builds indexes and is idempotent', async () => {
    const legacy = await fixture('failed');
    const current = await fixture('pending', legacy.intent.sessionId);
    const succeeded = await fixture('succeeded', legacy.intent.sessionId);
    await db
      .collection('payment_intents')
      .updateOne(
        { _id: succeeded.intent._id },
        { $set: { ipnConfirmed: true } },
      );
    await db
      .collection('orders')
      .updateOne(
        { _id: succeeded.order._id },
        { $set: { status: 'Paid', paidAt: new Date() } },
      );
    const originalSucceeded = await db
      .collection('payment_intents')
      .findOne({ _id: succeeded.intent._id });
    const originalOrders = await db
      .collection('orders')
      .find()
      .sort({ _id: 1 })
      .toArray();
    const receipts = [signedFailure(legacy.intent.txnRef)];
    const preview = await migratePaymentIntents(client, db, {
      ...options,
      receipts,
      log,
    });
    expect(preview).toMatchObject({
      conflictSessions: 1,
      conflictDocuments: 2,
      documentsToUpdate: 1,
      ambiguousSessions: [],
    });
    expect(
      await db
        .collection('payment_intents')
        .countDocuments(UNRESOLVED_PAYMENT_FILTER),
    ).toBe(2);
    await migratePaymentIntents(client, db, {
      ...options,
      receipts,
      apply: true,
      writesPaused: true,
      log,
    });
    expect(
      await db
        .collection('payment_intents')
        .findOne({ _id: legacy.intent._id }),
    ).toMatchObject({ status: 'failed', ipnConfirmed: true });
    expect(
      await db
        .collection('payment_intents')
        .findOne({ _id: succeeded.intent._id }),
    ).toEqual(originalSucceeded);
    expect(
      await db.collection('orders').find().sort({ _id: 1 }).toArray(),
    ).toEqual(originalOrders);
    expect(
      await db
        .collection('payment_intents')
        .countDocuments(UNRESOLVED_PAYMENT_FILTER),
    ).toBe(1);
    const index = (await db.collection('payment_intents').indexes()).find(
      (i) => i.name === SESSION_INDEX,
    );
    expect(index).toMatchObject({
      unique: true,
      key: { sessionId: 1 },
      partialFilterExpression: UNRESOLVED_PAYMENT_FILTER,
    });
    // Different txnRef, coverage and orders isolate the per-session database constraint.
    await expect(
      db.collection('payment_intents').insertOne({
        ...current.intent,
        _id: new mongo.ObjectId(),
        txnRef: 'new-checkout',
        coverageKey: 'new-coverage',
        invoiceCode: 'new-invoice',
        coveredOrderIds: [new mongo.ObjectId()],
      }),
    ).rejects.toMatchObject({ code: 11000, keyPattern: { sessionId: 1 } });
    const repeated = await migratePaymentIntents(client, db, {
      ...options,
      receipts,
      apply: true,
      writesPaused: true,
    });
    expect(repeated).toMatchObject({
      conflictSessions: 0,
      documentsToUpdate: 0,
    });
  });

  it('reconciles two portal successes without fabricating IPNs or changing already-paid Orders', async () => {
    const first = await fixture();
    const second = await fixture('pending', first.intent.sessionId);
    const settled = await fixture('succeeded', first.intent.sessionId);
    await db.collection('payment_intents').updateOne(
      { _id: second.intent._id },
      {
        $set: { coveredOrderIds: first.intent.coveredOrderIds },
      },
    );
    await db.collection('payment_intents').updateOne(
      { _id: settled.intent._id },
      {
        $set: { transactionNo: '999', responseCode: '00', ipnConfirmed: true },
      },
    );
    await db.collection('orders').updateMany(
      { sessionId: first.intent.sessionId },
      {
        $set: {
          status: 'Paid',
          paidAt: new Date('2026-01-01T01:00:00Z'),
          statusHistory: [{ toStatus: 'Paid', transactionNo: '999' }],
        },
      },
    );
    const originalOrders = await db
      .collection('orders')
      .find()
      .sort({ _id: 1 })
      .toArray();
    const originalIntents = await db
      .collection('payment_intents')
      .find()
      .sort({ _id: 1 })
      .toArray();
    const portalEvidence: PortalEvidence = {
      source: 'vnpay-sandbox-merchant-portal',
      capturedAt: '2026-02-01T00:00:00Z',
      payments: [first, second].map(({ intent }, n) => ({
        tmnCode,
        txnRef: intent.txnRef,
        amount: 10000,
        currency: 'VND',
        status: 'succeeded',
        responseCode: '00',
        transactionNo: String(100 + n),
        confirmedAt: '2026-01-01T00:01:00Z',
        sourceUrl: `https://sandbox.vnpayment.vn/merchantv2/Transaction/PaymentDetail/${100 + n}.htm`,
      })),
    };
    for (const invalid of [
      { ...portalEvidence, payments: portalEvidence.payments.slice(0, 1) },
      {
        ...portalEvidence,
        payments: portalEvidence.payments.map((p) => ({
          ...p,
          tmnCode: 'WRONG',
        })),
      },
      {
        ...portalEvidence,
        payments: portalEvidence.payments.map((p) => ({ ...p, amount: 1 })),
      },
    ]) {
      await expect(
        migratePaymentIntents(client, db, {
          ...options,
          portalEvidence: invalid,
          apply: true,
          log,
        }),
      ).rejects.toThrow('Manual reconciliation');
      expect(
        await db
          .collection('payment_intents')
          .find()
          .sort({ _id: 1 })
          .toArray(),
      ).toEqual(originalIntents);
    }
    const preview = await migratePaymentIntents(client, db, {
      ...options,
      portalEvidence,
      log,
    });
    expect(preview).toMatchObject({
      conflictDocuments: 2,
      conflictOrders: 1,
      documentsToUpdate: 2,
      ambiguousSessions: [],
    });
    expect(
      await db.collection('payment_intents').find().sort({ _id: 1 }).toArray(),
    ).toEqual(originalIntents);
    // Online reconciliation is restricted to verified successes with already-paid Orders.
    await migratePaymentIntents(client, db, {
      ...options,
      portalEvidence,
      apply: true,
      log,
    });
    for (const [n, { intent }] of [first, second].entries()) {
      const updated = await db
        .collection('payment_intents')
        .findOne({ _id: intent._id });
      expect(updated).toMatchObject({
        status: 'succeeded',
        responseCode: '00',
        transactionNo: String(100 + n),
        completedAt: new Date('2026-01-01T00:01:00Z'),
      });
      expect(updated).not.toHaveProperty('ipnConfirmed');
    }
    expect(
      await db.collection('orders').find().sort({ _id: 1 }).toArray(),
    ).toEqual(originalOrders);
    expect(
      await db
        .collection('payment_intents')
        .findOne({ _id: settled.intent._id }),
    ).toEqual(originalIntents.find((i) => i._id.equals(settled.intent._id)));
    expect(
      await db
        .collection('payment_intents')
        .countDocuments(UNRESOLVED_PAYMENT_FILTER),
    ).toBe(0);
    const indexes = await db.collection('payment_intents').indexes();
    for (const [name, key] of [
      [SESSION_INDEX, { sessionId: 1 }],
      [ORDER_INDEX, { coveredOrderIds: 1 }],
    ]) {
      expect(indexes.find((i) => i.name === name)).toMatchObject({
        unique: true,
        key,
        partialFilterExpression: UNRESOLVED_PAYMENT_FILTER,
      });
    }
    expect(
      await migratePaymentIntents(client, db, {
        ...options,
        portalEvidence,
        apply: true,
        log,
      }),
    ).toMatchObject({ conflictDocuments: 0, documentsToUpdate: 0 });
  });

  it('rejects a wrong deployment target before connecting', () => {
    expect(() =>
      assertDeploymentTarget(
        'mongodb://host/production',
        'other',
        'production',
        'production',
      ),
    ).toThrow('target mismatch');
    expect(() =>
      assertDeploymentTarget(
        'mongodb://host/test',
        'host',
        'test',
        'production',
      ),
    ).toThrow('target mismatch');
    expect(() =>
      assertDeploymentTarget(
        'mongodb://host/OrderFood',
        'host',
        'OrderFood',
        'demo',
      ),
    ).not.toThrow();
  });

  it('keeps startup fail-closed and reports the affected index without leaking driver details', async () => {
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = new VnpayService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        createIndexes: jest.fn().mockRejectedValue({
          code: 11000,
          keyPattern: { sessionId: 1 },
          message: 'private-uri',
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.onModuleInit()).rejects.toThrow(SESSION_INDEX);
    expect(logger.mock.calls[0][0]).toContain('payment_intents');
    expect(logger.mock.calls[0][0]).not.toContain('private-uri');
  });
});
