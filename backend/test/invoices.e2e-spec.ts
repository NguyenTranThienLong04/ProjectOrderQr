import 'dotenv/config';
import * as dns from 'dns';
import crypto from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { VnpayModule } from '../src/modules/vnpay/vnpay.module';
import { VnpayService } from '../src/modules/vnpay/vnpay.service';
import {
  PaymentIntent,
  PaymentIntentDocument,
  PaymentIntentStatus,
} from '../src/modules/vnpay/payment-intent.schema';
import {
  ensureInvoiceCode,
  generateInvoiceCode,
  INVOICE_CODE_PATTERN,
} from '../src/modules/vnpay/invoice-code';
import { Order, OrderDocument } from '../src/modules/order/order.schema';
import {
  Session,
  SessionDocument,
} from '../src/modules/session/session.schema';
import { Table, TableDocument } from '../src/modules/table/table.schema';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { TableStatus } from '../src/common/enums/table-status.enum';
import { JwtStrategy } from '../src/modules/auth/jwt.strategy';
import { AbandonedSessionCleanupService } from '../src/modules/session/abandoned-session-cleanup.service';
import { InvoiceDetailDto } from '../src/modules/invoice/dto/invoice.dto';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);

describe('Invoice codes: isolated Mongo + real JWT/HTTP/payment', () => {
  const dbName = `smartorder_invoices_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const secret = 'invoice-integration-only';
  const jwt = new JwtService({ secret });
  let app: INestApplication<App>, connection: Connection;
  let intents: Model<PaymentIntentDocument>,
    orders: Model<OrderDocument>,
    sessions: Model<SessionDocument>,
    tables: Model<TableDocument>;
  let vnpay: VnpayService,
    table: TableDocument,
    session: SessionDocument,
    covered: OrderDocument[];
  const auth = (role = 'admin') =>
    `Bearer ${jwt.sign({ sub: 'fixture', email: 'fixture@example.invalid', role })}`;
  const get = (code: string, suffix = '') =>
    request(app.getHttpServer())
      .get(`/admin/invoices/${encodeURIComponent(code)}${suffix}`)
      .set('Authorization', auth());
  const checkout = () =>
    vnpay.createPaymentUrl(session.id, table.id, '127.0.0.1');
  const signedIpn = (intent: PaymentIntentDocument) => {
    const params: Record<string, string> = {
      vnp_TxnRef: intent.txnRef,
      vnp_Amount: String(intent.amount * 100),
      vnp_ResponseCode: '00',
      vnp_TransactionNo: '123456789',
    };
    params.vnp_SecureHash = (
      vnpay as unknown as { sign: (params: Record<string, string>) => string }
    ).sign(params);
    return params;
  };
  const paidIntent = async () => {
    const result = await checkout();
    const intent = await intents
      .findOne({ txnRef: result.txnRef })
      .orFail()
      .exec();
    expect(await vnpay.handleIpn(signedIpn(intent))).toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    return intents.findById(intent._id).orFail().exec();
  };

  beforeAll(async () => {
    if (!process.env.MONGODB_URI || process.env.NODE_ENV === 'production')
      throw new Error(
        'Requires non-production Mongo connection; isolated dbName only',
      );
    const fixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        MongooseModule.forRoot(process.env.MONGODB_URI, {
          dbName,
          retryAttempts: 0,
          serverSelectionTimeoutMS: 15000,
        }),
        VnpayModule,
      ],
      providers: [JwtStrategy],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JWT_ACCESS_SECRET: secret,
          VNP_HASH_SECRET: secret,
          VNP_TMN_CODE: 'TEST',
          VNP_RETURN_URL: 'http://localhost/return',
          VNP_URL: 'https://example.invalid/pay',
        }),
      )
      .overrideProvider(AbandonedSessionCleanupService)
      .useValue({})
      .compile();
    app = fixture.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    connection = fixture.get(getConnectionToken());
    expect(connection.name).toBe(dbName);
    intents = fixture.get(getModelToken(PaymentIntent.name));
    orders = fixture.get(getModelToken(Order.name));
    sessions = fixture.get(getModelToken(Session.name));
    tables = fixture.get(getModelToken(Table.name));
    vnpay = fixture.get(VnpayService);
    await intents.init();
  });

  beforeEach(async () => {
    table = await tables.create({
      tableCode: `A-${crypto.randomUUID().slice(0, 8)}`,
      qrCodeUrl: 'test',
      status: TableStatus.WAITING_PAYMENT,
    });
    session = await sessions.create({
      tableId: table._id,
      tableIds: [table._id],
    });
    await tables.updateOne(
      { _id: table._id },
      { $set: { currentSessionId: session._id } },
    );
    covered = [];
    for (const [price, discount] of [
      [100000, 0],
      [250000, 50000],
    ]) {
      covered.push(
        await orders.create({
          sessionId: session._id,
          tableId: table._id,
          status: OrderStatus.SERVED,
          items: [
            {
              dishId: new Types.ObjectId(),
              dishName: 'Món snapshot',
              nameEn: 'Snapshot dish',
              quantity: 2,
              unitPrice: price / 2,
              note: 'Không hành',
              status: OrderStatus.SERVED,
            },
          ],
          subtotalAmount: price,
          discountAmount: discount,
          totalAmount: price - discount,
        }),
      );
    }
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (
      connection?.name === dbName &&
      dbName.startsWith('smartorder_invoices_')
    )
      await connection.dropDatabase();
    await app?.close();
  });

  it('persists a unique indexed code, rejects duplicate writes, and keeps it immutable on save/update', async () => {
    const result = await checkout();
    const intent = await intents
      .findOne({ txnRef: result.txnRef })
      .orFail()
      .exec();
    expect(intent.invoiceCode).toMatch(INVOICE_CODE_PATTERN);
    const indexes = await intents.collection.indexes();
    expect(indexes.find((index) => index.key.invoiceCode === 1)?.unique).toBe(
      true,
    );
    await expect(
      intents.create({
        ...intent.toObject(),
        _id: new Types.ObjectId(),
        txnRef: 'duplicate-code',
        coverageKey: 'different',
      }),
    ).rejects.toMatchObject({ code: 11000, keyPattern: { invoiceCode: 1 } });
    const code = intent.invoiceCode;
    intent.invoiceCode = generateInvoiceCode();
    await intent.save();
    await intents.updateOne(
      { _id: intent._id },
      { $set: { invoiceCode: generateInvoiceCode() } },
    );
    expect((await intents.findById(intent._id))?.invoiceCode).toBe(code);
  });

  it('real invoice index collision is regenerated; 5 repeated collisions become controlled 503', async () => {
    const code = generateInvoiceCode().slice(0, 13) + 'AAAAAAAA';
    await intents.create({
      invoiceCode: code,
      txnRef: crypto.randomUUID(),
      coverageKey: crypto.randomUUID(),
      sessionId: session._id,
      tableId: table._id,
      amount: 1,
      paymentUrl: 'test',
      expiresAt: new Date(),
      status: PaymentIntentStatus.FAILED,
    });
    const random = jest.spyOn(
      crypto,
      'randomInt',
    ) as unknown as jest.SpyInstance<number, [number]>;
    for (let i = 0; i < 8; i++) random.mockReturnValueOnce(0);
    const result = await checkout();
    expect(
      (await intents.findOne({ txnRef: result.txnRef }))?.invoiceCode,
    ).not.toBe(code);
    await intents.updateOne(
      { txnRef: result.txnRef },
      { $set: { status: PaymentIntentStatus.FAILED } },
    );
    random.mockClear().mockReturnValue(0);
    await expect(checkout()).rejects.toMatchObject({ status: 503 });
    expect(random).toHaveBeenCalledTimes(40);
    expect((await orders.findById(covered[0]._id))?.status).toBe(
      OrderStatus.SERVED,
    );
  });

  it('concurrent checkout preserves one pending coverage and one public code', async () => {
    const results = await Promise.all([checkout(), checkout(), checkout()]);
    expect(new Set(results.map((result) => result.txnRef)).size).toBe(1);
    expect(await intents.countDocuments({ sessionId: session._id })).toBe(1);
  });

  it('valid normalized lookup returns only display DTO, snapshots, totals, table and provider number', async () => {
    const intent = await paidIntent();
    const response = await get(` ${intent.invoiceCode!.toLowerCase()} `).expect(
      200,
    );
    expect(response.body).toMatchObject({
      invoiceCode: intent.invoiceCode,
      paymentStatus: 'succeeded',
      table: { displayName: table.tableCode },
      vnpTransactionNo: '123456789',
      subtotalAmount: 350000,
      discountAmount: 50000,
      totalAmount: 300000,
    });
    const detail = response.body as InvoiceDetailDto;
    expect(detail.orders).toHaveLength(2);
    expect(detail.orders[1]).toMatchObject({
      sequence: 2,
      items: [
        {
          name: 'Món snapshot',
          nameEn: 'Snapshot dish',
          quantity: 2,
          unitPrice: 125000,
          note: 'Không hành',
        },
      ],
      subtotalAmount: 250000,
      discountAmount: 50000,
      totalAmount: 200000,
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /"(?:_id|id|sessionId|orderId|dishId|tableId|txnRef|coveredOrderIds)"/,
    );
    for (const id of [
      intent.id,
      session.id,
      table.id,
      ...covered.map((order) => order.id),
    ])
      expect(JSON.stringify(response.body)).not.toContain(id);
  });

  it('unknown valid code gives clear 404', async () => {
    const response = await get('INV-19990101-ABCDEFGH').expect(404);
    expect((response.body as { message: string }).message).toBe(
      'Không tìm thấy hóa đơn',
    );
  });
  it.each([
    'bad',
    '507f1f77bcf86cd799439011',
    'INV-20260910-OOII0011',
    '{"$ne":null}',
  ])('malformed input %s gives 400', async (code) => {
    await get(code).expect(400);
  });
  it.each(['kitchen', 'waiter', 'customer'])(
    '%s cannot use lookup or PDF',
    async (role) => {
      for (const suffix of ['', '/pdf'])
        await request(app.getHttpServer())
          .get(`/admin/invoices/INV-20260910-K7P4X2M9${suffix}`)
          .set('Authorization', auth(role))
          .expect(403);
    },
  );
  it('unauthenticated/invalid JWT requests cannot look up or download', async () => {
    for (const suffix of ['', '/pdf']) {
      await request(app.getHttpServer())
        .get(`/admin/invoices/INV-20260910-K7P4X2M9${suffix}`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/admin/invoices/INV-20260910-K7P4X2M9${suffix}`)
        .set('Authorization', 'Bearer invalid')
        .expect(401);
    }
  });

  it('legacy missing/null codes coexist and concurrent lazy allocation persists exactly one code without other writes', async () => {
    const intent = await paidIntent();
    await intents.collection.updateOne(
      { _id: intent._id },
      { $unset: { invoiceCode: '' } },
    );
    const legacy = await intents.findById(intent._id).orFail().exec();
    expect(legacy.invoiceCode).toBeUndefined();
    const raw = legacy.toObject();
    await intents.collection.insertOne({
      ...raw,
      _id: new Types.ObjectId(),
      txnRef: crypto.randomUUID(),
      invoiceCode: null,
    });
    const codes = await Promise.all(
      Array.from({ length: 8 }, () => ensureInvoiceCode(intents, legacy)),
    );
    expect(new Set(codes).size).toBe(1);
    const after = await intents.findById(intent._id).orFail().exec();
    expect(after.toObject()).toEqual({ ...raw, invoiceCode: codes[0] });
    expect(await ensureInvoiceCode(intents, after)).toBe(codes[0]);
    await get(codes[0]).expect(200);
  });

  it('customer and admin PDFs use public filenames; ownership remains required even with a known code', async () => {
    const intent = await paidIntent();
    const expected = `attachment; filename="SmartOrder-${intent.invoiceCode}.pdf"`;
    await get(intent.invoiceCode!, '/pdf')
      .expect(200)
      .expect('Content-Type', /application\/pdf/)
      .expect('Content-Disposition', expected);
    await request(app.getHttpServer())
      .get('/vnpay/session-invoice')
      .query({
        txnRef: intent.txnRef,
        sessionId: session.id,
        tableId: table.id,
      })
      .expect(200)
      .expect('Content-Disposition', expected);
    await request(app.getHttpServer())
      .get(`/orders/${covered[0].id}/invoice`)
      .query({ sessionId: session.id })
      .expect(200)
      .expect('Content-Disposition', expected);
    await request(app.getHttpServer())
      .get('/vnpay/session-invoice')
      .query({
        txnRef: intent.txnRef,
        sessionId: new Types.ObjectId().toString(),
        tableId: table.id,
      })
      .expect(403);
    await request(app.getHttpServer())
      .get(`/invoices/${intent.invoiceCode}`)
      .expect(404);
  });

  it('legacy customer access allocates once, including after the Session closes', async () => {
    const intent = await paidIntent();
    await intents.collection.updateOne(
      { _id: intent._id },
      { $unset: { invoiceCode: '' } },
    );
    await sessions.updateOne(
      { _id: session._id },
      { $set: { status: 'closed' } },
    );
    const query = {
      txnRef: intent.txnRef,
      sessionId: session.id,
      tableId: table.id,
    };
    const first = await request(app.getHttpServer())
      .get('/vnpay/session-invoice')
      .query(query)
      .expect(200);
    const second = await request(app.getHttpServer())
      .get('/vnpay/session-invoice')
      .query(query)
      .expect(200);
    const persisted = await intents.findById(intent._id).orFail().exec();
    expect(persisted.invoiceCode).toMatch(INVOICE_CODE_PATTERN);
    expect(first.headers['content-disposition']).toBe(
      `attachment; filename="SmartOrder-${persisted.invoiceCode}.pdf"`,
    );
    expect(second.headers['content-disposition']).toBe(
      first.headers['content-disposition'],
    );
  });

  it('missing coverage or mismatched amount never returns an incomplete invoice', async () => {
    const intent = await paidIntent();
    await orders.updateOne(
      { _id: covered[0]._id },
      { $set: { totalAmount: 999 } },
    );
    await get(intent.invoiceCode!).expect(409);
    await orders.deleteOne({ _id: covered[0]._id });
    await get(intent.invoiceCode!).expect(404);
  });

  it('pre-PaymentIntent Paid Order endpoint remains accessible without a fabricated payment', async () => {
    const intent = await paidIntent();
    await intents.deleteOne({ _id: intent._id });
    await request(app.getHttpServer())
      .get(`/orders/${covered[0].id}/invoice`)
      .query({ sessionId: session.id })
      .expect(200)
      .expect(
        'Content-Disposition',
        'attachment; filename="SmartOrder-invoice.pdf"',
      );
    expect(await intents.countDocuments({ sessionId: session._id })).toBe(0);
    await request(app.getHttpServer())
      .get(`/orders/${covered[0].id}/invoice`)
      .query({ sessionId: new Types.ObjectId().toString() })
      .expect(403);
  });

  it('pending/failed invoice details are explicit and cannot download a paid receipt', async () => {
    const result = await checkout();
    const intent = await intents
      .findOne({ txnRef: result.txnRef })
      .orFail()
      .exec();
    expect(
      ((await get(intent.invoiceCode!).expect(200)).body as InvoiceDetailDto)
        .paidAt,
    ).toBeNull();
    await get(intent.invoiceCode!, '/pdf').expect(403);
    await intents.updateOne(
      { _id: intent._id },
      { $set: { status: PaymentIntentStatus.FAILED } },
    );
    expect(
      ((await get(intent.invoiceCode!).expect(200)).body as InvoiceDetailDto)
        .paymentStatus,
    ).toBe('failed');
    await get(intent.invoiceCode!, '/pdf').expect(403);
  });

  it('verified IPN alone pays cutoff Orders, duplicate is idempotent, later Order stays Served', async () => {
    const result = await checkout();
    const intent = await intents
      .findOne({ txnRef: result.txnRef })
      .orFail()
      .exec();
    const later = await orders.create({
      ...covered[0].toObject(),
      _id: new Types.ObjectId(),
    });
    const params = signedIpn(intent);
    await vnpay.handleReturn(params);
    expect((await orders.findById(covered[0]._id))?.status).toBe(
      OrderStatus.SERVED,
    );
    expect(
      (await vnpay.handleIpn({ ...params, vnp_SecureHash: 'bad' })).RspCode,
    ).toBe('97');
    expect((await vnpay.handleIpn(params)).RspCode).toBe('00');
    expect((await vnpay.handleIpn(params)).RspCode).toBe('02');
    const detail = (await get(intent.invoiceCode!).expect(200))
      .body as InvoiceDetailDto;
    expect(detail.orders).toHaveLength(2);
    expect(detail.totalAmount).toBe(300000);
    expect((await orders.findById(later._id))?.status).toBe(OrderStatus.SERVED);
    expect((await intents.findById(intent._id))?.invoiceCode).toBe(
      intent.invoiceCode,
    );
    expect((await sessions.findById(session._id))?.status).toBe('active');
    expect((await tables.findById(table._id))?.status).toBe(
      TableStatus.WAITING_PAYMENT,
    );
    for (const order of covered)
      expect(
        (await orders.findById(order._id))?.statusHistory.filter(
          (entry) => entry.toStatus === OrderStatus.PAID,
        ),
      ).toHaveLength(1);
  });
});
