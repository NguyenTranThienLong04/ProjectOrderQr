import 'dotenv/config';
import * as dns from 'dns';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { SessionStatus } from '../src/common/enums/session-status.enum';
import { TableStatus } from '../src/common/enums/table-status.enum';
import { Order, OrderDocument } from '../src/modules/order/order.schema';
import {
  Session,
  SessionDocument,
} from '../src/modules/session/session.schema';
import { Table, TableDocument } from '../src/modules/table/table.schema';
import { TableService } from '../src/modules/table/table.service';
import {
  PaymentIntent,
  PaymentIntentDocument,
  PaymentIntentStatus,
} from '../src/modules/vnpay/payment-intent.schema';
import { VnpayService } from '../src/modules/vnpay/vnpay.service';

if (process.env.CUSTOM_DNS_SERVERS) {
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
}

describe('Session payment (real MongoDB + HTTP IPN)', () => {
  let app: INestApplication;
  let orderModel: Model<OrderDocument>;
  let sessionModel: Model<SessionDocument>;
  let tableModel: Model<TableDocument>;
  let paymentIntentModel: Model<PaymentIntentDocument>;
  let vnpayService: VnpayService;
  let tableService: TableService;
  let table: TableDocument;
  let session: SessionDocument;
  let coveredOrders: OrderDocument[];
  const createdOrderIds: Types.ObjectId[] = [];
  const createdSessionIds: Types.ObjectId[] = [];
  const createdTableIds: Types.ObjectId[] = [];

  const createServedOrder = async (
    totalAmount: number,
    subtotalAmount = totalAmount,
  ) => {
    const order = await orderModel.create({
      sessionId: session._id,
      tableId: table._id,
      status: OrderStatus.SERVED,
      items: [
        {
          dishId: new Types.ObjectId(),
          dishName: `__session_payment_item_${totalAmount}__`,
          unitPrice: subtotalAmount,
          quantity: 1,
          status: OrderStatus.SERVED,
        },
      ],
      subtotalAmount,
      discountAmount: subtotalAmount - totalAmount,
      totalAmount,
    });
    createdOrderIds.push(order._id);
    return order;
  };

  const signedIpn = (intent: PaymentIntentDocument) => {
    const params: Record<string, string> = {
      vnp_TxnRef: intent.txnRef,
      vnp_Amount: String(intent.amount * 100),
      vnp_ResponseCode: '00',
      vnp_TransactionNo: `E2E${Date.now()}`,
    };
    params.vnp_SecureHash = (
      vnpayService as unknown as {
        sign: (values: Record<string, string>) => string;
      }
    ).sign(params);
    return params;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    orderModel = moduleFixture.get(getModelToken(Order.name));
    sessionModel = moduleFixture.get(getModelToken(Session.name));
    tableModel = moduleFixture.get(getModelToken(Table.name));
    paymentIntentModel = moduleFixture.get(getModelToken(PaymentIntent.name));
    vnpayService = moduleFixture.get(VnpayService);
    tableService = moduleFixture.get(TableService);
  });

  beforeEach(async () => {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
    table = await tableModel.create({
      tableCode: `__PAY_${suffix}__`,
      status: TableStatus.WAITING_PAYMENT,
      qrCodeUrl: 'data:image/png;base64,e2e',
    });
    createdTableIds.push(table._id);
    session = await sessionModel.create({
      tableId: table._id,
      tableIds: [table._id],
      status: SessionStatus.ACTIVE,
      cart: [],
    });
    createdSessionIds.push(session._id);
    await tableModel.updateOne(
      { _id: table._id },
      { $set: { currentSessionId: session._id } },
    );
    table.currentSessionId = session._id;
    coveredOrders = [
      await createServedOrder(100_000),
      await createServedOrder(200_000, 250_000),
    ];
  });

  it('one checkout creates one txnRef and one IPN pays both covered Orders', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/vnpay/create-payment-url')
      .send({ sessionId: session.id, tableId: table.id })
      .expect(201);
    expect(createResponse.body).toMatchObject({
      amount: 300_000,
      coveredOrderIds: coveredOrders.map((order) => order.id),
    });
    expect(
      new URL(createResponse.body.paymentUrl).searchParams.get('vnp_Amount'),
    ).toBe('30000000');

    const intent = await paymentIntentModel
      .findOne({ txnRef: createResponse.body.txnRef })
      .exec();
    expect(intent).not.toBeNull();
    expect(intent!.status).toBe(PaymentIntentStatus.PENDING);
    expect(intent!.coveredOrderIds.map((id) => id.toString())).toEqual(
      coveredOrders.map((order) => order.id),
    );

    const ipn = signedIpn(intent!);
    await request(app.getHttpServer())
      .get('/vnpay/ipn')
      .query(ipn)
      .expect(200)
      .expect({ RspCode: '00', Message: 'Confirm Success' });

    const paid = await orderModel
      .find({ _id: { $in: coveredOrders.map((order) => order._id) } })
      .sort({ createdAt: 1 })
      .exec();
    expect(paid.map((order) => order.status)).toEqual([
      OrderStatus.PAID,
      OrderStatus.PAID,
    ]);
    expect(
      paid.map(
        (order) =>
          order.statusHistory.filter(
            (entry) => entry.toStatus === OrderStatus.PAID,
          ).length,
      ),
    ).toEqual([1, 1]);
    expect(paid.reduce((sum, order) => sum + order.totalAmount, 0)).toBe(
      300_000,
    );
    expect((await sessionModel.findById(session._id).exec())?.status).toBe(
      SessionStatus.ACTIVE,
    );
    expect((await tableModel.findById(table._id).exec())?.status).toBe(
      TableStatus.WAITING_PAYMENT,
    );

    await request(app.getHttpServer())
      .get('/vnpay/ipn')
      .query(ipn)
      .expect(200)
      .expect({ RspCode: '02', Message: 'Order already confirmed' });
    const afterDuplicate = await orderModel
      .find({ _id: { $in: coveredOrders.map((order) => order._id) } })
      .exec();
    expect(
      afterDuplicate.map(
        (order) =>
          order.statusHistory.filter(
            (entry) => entry.toStatus === OrderStatus.PAID,
          ).length,
      ),
    ).toEqual([1, 1]);

    await request(app.getHttpServer())
      .get('/vnpay/session-invoice')
      .query({
        txnRef: intent!.txnRef,
        sessionId: session.id,
        tableId: table.id,
      })
      .expect('Content-Type', /application\/pdf/)
      .expect(200);

    await tableService.clear(table.id);
    expect((await sessionModel.findById(session._id).exec())?.status).toBe(
      SessionStatus.CLOSED,
    );
    expect((await tableModel.findById(table._id).exec())?.status).toBe(
      TableStatus.AVAILABLE,
    );
  });

  it('an Order created after checkout remains Served when the old IPN succeeds', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/vnpay/create-payment-url')
      .send({ sessionId: session.id, tableId: table.id })
      .expect(201);
    const intent = await paymentIntentModel
      .findOne({ txnRef: createResponse.body.txnRef })
      .exec();
    const laterOrder = await createServedOrder(50_000);

    await request(app.getHttpServer())
      .get('/vnpay/ipn')
      .query(signedIpn(intent!))
      .expect(200)
      .expect({ RspCode: '00', Message: 'Confirm Success' });

    const statuses = await orderModel
      .find({
        _id: {
          $in: [...coveredOrders.map((order) => order._id), laterOrder._id],
        },
      })
      .sort({ createdAt: 1 })
      .select('status')
      .exec();
    expect(statuses.map((order) => order.status)).toEqual([
      OrderStatus.PAID,
      OrderStatus.PAID,
      OrderStatus.SERVED,
    ]);
    const summary = await request(app.getHttpServer())
      .get('/vnpay/session-summary')
      .query({ sessionId: session.id, tableId: table.id })
      .expect(200);
    expect(summary.body).toMatchObject({
      orderCount: 1,
      payableTotal: 50_000,
      canPay: true,
      fullyPaid: false,
    });
    await expect(tableService.clear(table.id)).rejects.toThrow(
      'vẫn còn đơn chưa thanh toán',
    );
  });

  afterAll(async () => {
    await paymentIntentModel.deleteMany({
      sessionId: { $in: createdSessionIds },
    });
    await orderModel.deleteMany({ _id: { $in: createdOrderIds } });
    await sessionModel.deleteMany({ _id: { $in: createdSessionIds } });
    await tableModel.deleteMany({ _id: { $in: createdTableIds } });
    await app.close();
  });
});
