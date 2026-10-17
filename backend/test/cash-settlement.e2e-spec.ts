import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/common/enums/user-role.enum';
import { OrderStatus } from '../src/common/enums/order-status.enum';
import { User, UserDocument } from '../src/modules/user/user.schema';
import { Order, OrderDocument } from '../src/modules/order/order.schema';
import {
  Session,
  SessionDocument,
} from '../src/modules/session/session.schema';
import { Table, TableDocument } from '../src/modules/table/table.schema';
import { SocketAuthService } from '../src/gateway/socket-auth.service';
import { VnpayService } from '../src/modules/vnpay/vnpay.service';
import {
  PaymentIntent,
  PaymentIntentDocument,
} from '../src/modules/vnpay/payment-intent.schema';
import { InvoiceDetailDto } from '../src/modules/invoice/dto/invoice.dto';

describe('Cash settlement HTTP authorization and QR lifecycle', () => {
  let app: INestApplication<App>;
  let tables: Model<TableDocument>;
  let sessions: Model<SessionDocument>;
  let orders: Model<OrderDocument>;
  let intents: Model<PaymentIntentDocument>;
  const tokens = new Map<UserRole, string>();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication<INestApplication<App>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    tables = app.get(getModelToken(Table.name));
    sessions = app.get(getModelToken(Session.name));
    orders = app.get(getModelToken(Order.name));
    intents = app.get(getModelToken(PaymentIntent.name));
    const users = app.get<Model<UserDocument>>(getModelToken(User.name));
    for (const role of [UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN]) {
      const user = await users.create({
        fullName: role,
        email: `${role}@cash.test`,
        passwordHash: 'unused-fixture',
        role,
      });
      tokens.set(
        role,
        new JwtService({ secret: process.env.JWT_ACCESS_SECRET }).sign({
          sub: user.id,
          role,
          email: user.email,
        }),
      );
    }
  });
  afterAll(async () => {
    await app?.close();
  });

  it.each([UserRole.ADMIN, UserRole.WAITER])(
    '%s confirms server-owned CASH; anonymous/kitchen/status injection are rejected and rescanning gets a new grant',
    async (role) => {
      const table = await tables.create({
        tableCode: `CASH-${role}`,
        qrCodeUrl: 'fixture',
      });
      const session = await sessions.create({
        tableId: table._id,
        tableIds: [table._id],
      });
      await tables.updateOne(
        { _id: table._id },
        { $set: { currentSessionId: session._id, status: 'waiting_payment' } },
      );
      const order = await orders.create({
        tableId: table._id,
        sessionId: session._id,
        status: OrderStatus.SERVED,
        subtotalAmount: 50000,
        discountAmount: 5000,
        promotionCode: 'CASH5',
        totalAmount: 45000,
        items: [
          {
            dishId: new Types.ObjectId(),
            dishName: 'Rice',
            unitPrice: 50000,
            quantity: 1,
            status: OrderStatus.SERVED,
          },
          {
            dishId: new Types.ObjectId(),
            dishName: 'Unavailable dish',
            unitPrice: 90000,
            quantity: 1,
            status: 'Rejected',
            rejectionReason: 'Sold out',
          },
        ],
      });
      const auth = app.get(SocketAuthService);
      const qr = await auth.issueTableEntry(table.id);
      const oldGrant = await auth.issueCustomer(session.id, table.id);
      const http = app.getHttpServer();
      const path = `/payments/tables/${table.id}/cash-settlement`;
      const token = `Bearer ${tokens.get(role)}`;
      await request(http).get(path).expect(401);
      await request(http).post(path).send({}).expect(401);
      await request(http)
        .get(path)
        .set('Authorization', `Bearer ${tokens.get(UserRole.KITCHEN)}`)
        .expect(403);
      const previewResponse = await request(http)
        .get(path)
        .set('Authorization', token)
        .expect(200);
      const preview = previewResponse.body as Awaited<
        ReturnType<VnpayService['getCashSettlementSummary']>
      >;
      expect(preview.payableTotal).toBe(45000);
      const confirmation = {
        sessionId: preview.sessionId,
        sessionVersion: preview.sessionVersion,
        confirmationKey: preview.confirmationKey,
      };
      await request(http)
        .post(path)
        .set('Authorization', `Bearer ${tokens.get(UserRole.KITCHEN)}`)
        .send(confirmation)
        .expect(403);
      await request(http)
        .post(path)
        .set('Authorization', token)
        .send({ ...confirmation, status: 'Paid', amount: 1 })
        .expect(400);
      await request(http)
        .patch(`/tables/${table.id}/clear`)
        .set('Authorization', token)
        .expect(409);
      const checkoutResponse = await request(http)
        .post('/vnpay/create-payment-url')
        .send({ sessionId: session.id, tableId: table.id })
        .expect(201);
      const checkout = checkoutResponse.body as { txnRef: string };
      const receiptResponse = await request(http)
        .post(path)
        .set('Authorization', token)
        .send(confirmation)
        .expect(201);
      const receipt = receiptResponse.body as {
        invoiceCode: string;
        amount: number;
      };
      expect(receipt).toMatchObject({ paymentMethod: 'CASH', amount: 45000 });
      const savedReceipt = await intents
        .findOne({ invoiceCode: receipt.invoiceCode })
        .orFail();
      expect(savedReceipt.paymentMethod).toBe('CASH');
      expect(savedReceipt.coveredOrderIds.map(String)).toEqual([order.id]);
      expect(
        await intents.countDocuments({ invoiceCode: receipt.invoiceCode }),
      ).toBe(1);
      expect((await tables.findById(table._id))?.toObject()).toMatchObject({
        status: 'available',
        currentSessionId: null,
      });
      expect((await sessions.findById(session._id))?.status).toBe('closed');
      const invoicePath = `/admin/invoices/${receipt.invoiceCode}`;
      const countBeforeReads = await intents.countDocuments();
      for (let attempt = 0; attempt < 2; attempt++) {
        const invoiceResponse = await request(http)
          .get(invoicePath)
          .set('Authorization', token)
          .expect(200);
        const invoice = invoiceResponse.body as InvoiceDetailDto;
        expect(invoice).toMatchObject({
          invoiceCode: receipt.invoiceCode,
          paymentMethod: 'CASH',
          paymentStatus: 'succeeded',
          totalAmount: 45000,
          subtotalAmount: 50000,
          discountAmount: 5000,
          settledByName: role,
          paidAt: expect.any(String) as unknown,
          table: { displayName: table.tableCode },
        });
        expect(invoice.vnpTransactionNo).toBeUndefined();
        expect(invoice.orders[0]).toMatchObject({ promotionCode: 'CASH5' });
        expect(invoice.orders[0].items[1]).toMatchObject({
          status: 'Rejected',
          chargedAmount: 0,
        });
        await request(http)
          .get(`${invoicePath}/pdf`)
          .set('Authorization', token)
          .expect(200)
          .expect('Content-Type', /application\/pdf/)
          .expect(
            'Content-Disposition',
            `attachment; filename="SmartOrder-${receipt.invoiceCode}.pdf"`,
          );
      }
      const history = await request(http)
        .get('/admin/invoices')
        .set('Authorization', token)
        .expect(200);
      expect(history.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invoiceCode: receipt.invoiceCode,
            amount: 45000,
          }),
        ]),
      );
      expect(await intents.countDocuments()).toBe(countBeforeReads);
      expect((await orders.findById(order._id))?.paymentMethod).toBe('CASH');
      await request(http)
        .post(path)
        .set('Authorization', token)
        .send(confirmation)
        .expect(409);
      const nextResponse = await request(http)
        .get('/sessions/active')
        .query({ tableId: table.id })
        .set('x-table-token', qr)
        .set('x-customer-token', oldGrant.customerToken)
        .expect(200);
      const next = nextResponse.body as {
        sessionId: string;
        currentOrder: unknown;
      };
      expect(next.sessionId).not.toBe(session.id);
      expect(next.currentOrder).toBeNull();
      await request(http)
        .get(invoicePath)
        .set('Authorization', token)
        .expect(200);
      await request(http)
        .get('/vnpay/payment-status')
        .query({
          txnRef: checkout.txnRef,
          sessionId: next.sessionId,
          tableId: table.id,
        })
        .expect(403);
      const summaryResponse = await request(http)
        .get('/vnpay/session-summary')
        .query({ sessionId: next.sessionId, tableId: table.id })
        .expect(200);
      const summary = summaryResponse.body as { orders: unknown[] };
      expect(summary.orders).toEqual([]);
    },
  );
});
