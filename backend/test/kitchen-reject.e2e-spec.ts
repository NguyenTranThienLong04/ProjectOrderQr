import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { UserRole } from '../src/common/enums/user-role.enum';
import { User, UserDocument } from '../src/modules/user/user.schema';
import { Order, OrderDocument } from '../src/modules/order/order.schema';
import {
  Session,
  SessionDocument,
} from '../src/modules/session/session.schema';
import { Table, TableDocument } from '../src/modules/table/table.schema';
import { SocketAuthService } from '../src/gateway/socket-auth.service';
import { AppGateway } from '../src/gateway/app.gateway';

describe('Kitchen rejection HTTP and realtime', () => {
  let app: INestApplication<App>;
  const sockets: Socket[] = [];
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
    await app.listen(0, '127.0.0.1');
    const users = app.get<Model<UserDocument>>(getModelToken(User.name));
    for (const role of [UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN]) {
      const user = await users.create({
        fullName: role,
        email: `${role}@reject.test`,
        passwordHash: 'unused',
        role,
      });
      tokens.set(
        role,
        new JwtService({ secret: process.env.JWT_ACCESS_SECRET }).sign(
          { sub: user.id, role, email: user.email },
          { expiresIn: 900 },
        ),
      );
    }
  });
  afterAll(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await app?.close();
  });

  async function connect(auth: Record<string, string>) {
    const socket = io(await app.getUrl(), {
      auth,
      transports: ['websocket'],
      reconnection: false,
      autoConnect: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
      socket.connect();
    });
    return socket;
  }
  function nextOrder(socket: Socket) {
    return new Promise<{
      totalAmount: number;
      items: { status: string; rejectionReason?: string }[];
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Missing order:updated')),
        5000,
      );
      socket.once(
        'order:updated',
        (payload: {
          totalAmount: number;
          items: { status: string; rejectionReason?: string }[];
        }) => {
          clearTimeout(timeout);
          resolve(payload);
        },
      );
    });
  }

  it('only Kitchen can reject; validated reason and committed amount reach customer/waiter sockets and queries', async () => {
    const tables = app.get<Model<TableDocument>>(getModelToken(Table.name));
    const sessions = app.get<Model<SessionDocument>>(
      getModelToken(Session.name),
    );
    const orders = app.get<Model<OrderDocument>>(getModelToken(Order.name));
    const table = await tables.create({
      tableCode: 'REJECT-E2E',
      qrCodeUrl: 'fixture',
    });
    const session = await sessions.create({
      tableId: table._id,
      tableIds: [table._id],
    });
    await tables.updateOne(
      { _id: table._id },
      { $set: { currentSessionId: session._id, status: 'occupied' } },
    );
    const orderId = new Types.ObjectId();
    const itemId = new Types.ObjectId();
    await orders.create({
      _id: orderId,
      tableId: table._id,
      sessionId: session._id,
      subtotalAmount: 30000,
      totalAmount: 30000,
      items: [
        {
          _id: itemId,
          dishId: new Types.ObjectId(),
          dishName: 'Soup',
          unitPrice: 20000,
          quantity: 1,
          status: 'Pending',
        },
        {
          dishId: new Types.ObjectId(),
          dishName: 'Rice',
          unitPrice: 10000,
          quantity: 1,
          status: 'Served',
        },
      ],
    });
    const customerGrant = await app
      .get(SocketAuthService)
      .issueCustomer(session.id, table.id);
    const customer = await connect({
      customerToken: customerGrant.customerToken,
    });
    const waiter = await connect({ token: tokens.get(UserRole.WAITER)! });
    const emit = jest.spyOn(app.get(AppGateway), 'emitOrderUpdated');
    const http = app.getHttpServer();
    const path = `/orders/${orderId.toString()}/items/${itemId.toString()}/status`;
    const body = { status: 'Rejected', rejectionReason: '  Hết nguyên liệu  ' };
    await request(http).patch(path).send(body).expect(401);
    await request(http)
      .patch(path)
      .set('Authorization', `Bearer ${customerGrant.customerToken}`)
      .send(body)
      .expect(401);
    for (const role of [UserRole.ADMIN, UserRole.WAITER])
      await request(http)
        .patch(path)
        .set('Authorization', `Bearer ${tokens.get(role)}`)
        .send(body)
        .expect(403);
    for (const reason of [undefined, '   ', 'x'.repeat(251)])
      await request(http)
        .patch(path)
        .set('Authorization', `Bearer ${tokens.get(UserRole.KITCHEN)}`)
        .send({ ...body, rejectionReason: reason })
        .expect(400);
    expect(emit).not.toHaveBeenCalled();
    const updates = Promise.all([nextOrder(customer), nextOrder(waiter)]);
    await request(http)
      .patch(path)
      .set('Authorization', `Bearer ${tokens.get(UserRole.KITCHEN)}`)
      .send(body)
      .expect(200);
    for (const payload of await updates) {
      expect(payload.totalAmount).toBe(10000);
      expect(payload.items[0]).toMatchObject({
        status: 'Rejected',
        rejectionReason: 'Hết nguyên liệu',
      });
    }
    const response = await request(http)
      .get('/orders/waiter')
      .set('Authorization', `Bearer ${tokens.get(UserRole.WAITER)}`)
      .expect(200);
    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orderId: orderId.toString(),
          items: [
            expect.objectContaining({
              status: 'Rejected',
              rejectionReason: 'Hết nguyên liệu',
            }),
          ],
        }),
      ]),
    );
    expect((await orders.findById(orderId).orFail()).totalAmount).toBe(10000);
    expect(emit).toHaveBeenCalledTimes(1);
    emit.mockRestore();
  });
});
