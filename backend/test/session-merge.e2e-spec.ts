import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as dns from 'dns';
import { Model, Types } from 'mongoose';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/modules/auth/auth.service';
import {
  Category,
  CategoryDocument,
} from '../src/modules/category/category.schema';
import { Dish, DishDocument } from '../src/modules/dish/dish.schema';
import { Order, OrderDocument } from '../src/modules/order/order.schema';
import { SessionService } from '../src/modules/session/session.service';
import {
  Session,
  SessionDocument,
} from '../src/modules/session/session.schema';
import { Table, TableDocument } from '../src/modules/table/table.schema';
import { User, UserDocument } from '../src/modules/user/user.schema';
import { UserRole } from '../src/common/enums/user-role.enum';
import { SessionStatus } from '../src/common/enums/session-status.enum';
import { TableStatus } from '../src/common/enums/table-status.enum';

const tableCodes = ['A01', 'A02', 'A03', 'A04', 'A05'];
const categoryName = '__phase7_merge_test__';
const dishNames = ['__phase7_merge_dish_1__', '__phase7_merge_dish_2__'];
const waiterEmail = '__phase7_merge_waiter__@test.local';

// E2E boots AppModule directly instead of main.ts, so honor the same explicit
// local opt-in before Mongoose resolves an Atlas SRV URI.
if (process.env.CUSTOM_DNS_SERVERS) {
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
  console.warn(
    `[Phase 7] Using custom DNS servers: ${process.env.CUSTOM_DNS_SERVERS}`,
  );
}

describe('Phase 7 table merge/unmerge (real MongoDB)', () => {
  let app: INestApplication;
  let token: string;
  let tables: Map<string, TableDocument>;
  let dishes: DishDocument[];
  let tableModel: Model<TableDocument>;
  let sessionModel: Model<SessionDocument>;
  let orderModel: Model<OrderDocument>;
  let dishModel: Model<DishDocument>;
  let categoryModel: Model<CategoryDocument>;
  let userModel: Model<UserDocument>;
  let sessionService: SessionService;

  const log = (label: string, value: unknown) =>
    console.log(`[Phase 7] ${label}: ${JSON.stringify(value)}`);
  const table = (code: string) => tables.get(code)!;
  const active = async (code: string) => {
    const response = await request(app.getHttpServer())
      .get('/sessions/active')
      .query({ tableId: table(code).id })
      .expect(200);
    log(`QR ${code} response`, response.body);
    return response.body as {
      sessionId: string;
      tableIds: string[];
      cart: Array<{ dishId: string; quantity: number }>;
    };
  };
  const merge = async (rootCode: string, sourceCode: string) => {
    const body = { tableIds: [table(rootCode).id, table(sourceCode).id] };
    const response = await request(app.getHttpServer())
      .post('/sessions/merge-tables')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    log(`merge ${rootCode}<-${sourceCode} request/response`, {
      body,
      status: response.status,
      response: response.body,
    });
    return response;
  };
  const addCart = (sessionId: string, dishIndex: number, quantity: number) =>
    sessionService.addToCart(sessionId, dishes[dishIndex].id, quantity);
  const createOrder = async (code: string) => {
    const response = await request(app.getHttpServer())
      .post('/orders')
      .send({ tableId: table(code).id })
      .expect(201);
    log(`order ${code} response`, response.body);
    return response.body as { orderId: string; sessionId: string };
  };

  async function seed() {
    const oldTables = await tableModel
      .find({ tableCode: { $in: tableCodes } })
      .select('_id')
      .exec();
    const oldTableIds = oldTables.map((item) => item._id);
    const oldSessions = await sessionModel
      .find({
        $or: [
          { tableId: { $in: oldTableIds } },
          { tableIds: { $in: oldTableIds } },
          { preMergeTableIds: { $in: oldTableIds } },
        ],
      })
      .select('_id')
      .exec();
    await orderModel
      .deleteMany({
        $or: [
          { tableId: { $in: oldTableIds } },
          { sessionId: { $in: oldSessions.map((item) => item._id) } },
        ],
      })
      .exec();
    await sessionModel
      .deleteMany({ _id: { $in: oldSessions.map((item) => item._id) } })
      .exec();
    await tableModel.deleteMany({ _id: { $in: oldTableIds } }).exec();
    await dishModel.deleteMany({ name: { $in: dishNames } }).exec();
    let category = await categoryModel.findOne({ name: categoryName }).exec();
    if (!category)
      category = await categoryModel.create({
        name: categoryName,
        description: 'Phase 7 isolated e2e fixtures',
        isActive: true,
      });
    const createdTables = await tableModel.insertMany(
      tableCodes.map((tableCode) => ({
        tableCode,
        status: TableStatus.AVAILABLE,
        qrCodeUrl: `phase7-test://${tableCode}`,
        capacity: 4,
        currentSessionId: null,
        groupedWithTableIds: [],
        mergeLockToken: null,
        mergeLockExpiresAt: null,
      })),
    );
    dishes = await dishModel.insertMany([
      {
        name: dishNames[0],
        description: 'Phase 7 dish 1',
        price: 45000,
        categoryId: category._id,
        isAvailable: true,
      },
      {
        name: dishNames[1],
        description: 'Phase 7 dish 2',
        price: 55000,
        categoryId: category._id,
        isAvailable: true,
      },
    ]);
    tables = new Map(createdTables.map((item) => [item.tableCode, item]));
    log('seed documents', {
      tables: createdTables.map((item) => ({
        id: item.id,
        tableCode: item.tableCode,
        status: item.status,
      })),
      dishes: dishes.map((item) => ({ id: item.id, name: item.name })),
    });
  }

  beforeAll(async () => {
    if (!process.env.MONGODB_URI)
      throw new Error(
        'Phase 7 e2e requires MONGODB_URI for a real MongoDB deployment.',
      );
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
    tableModel = app.get(getModelToken(Table.name));
    sessionModel = app.get(getModelToken(Session.name));
    orderModel = app.get(getModelToken(Order.name));
    dishModel = app.get(getModelToken(Dish.name));
    categoryModel = app.get(getModelToken(Category.name));
    userModel = app.get(getModelToken(User.name));
    sessionService = app.get(SessionService);
    const waiter = await userModel
      .findOneAndUpdate(
        { email: waiterEmail },
        {
          $set: {
            fullName: 'Phase 7 Test Waiter',
            email: waiterEmail,
            passwordHash: 'not-used',
            role: UserRole.WAITER,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      )
      .exec();
    token = (
      await app.get(AuthService).generateTokens({
        id: waiter.id,
        email: waiter.email,
        role: waiter.role,
        fullName: waiter.fullName,
      })
    ).accessToken;
  }, 60_000);

  beforeEach(seed);

  afterAll(async () => {
    if (userModel) await userModel.deleteOne({ email: waiterEmail }).exec();
    if (app) await app.close();
  });

  it('Case 1: groups two available tables without creating a session, then QR opens one shared session', async () => {
    const before = await sessionModel
      .countDocuments({
        tableIds: { $in: [table('A01')._id, table('A02')._id] },
      })
      .exec();
    expect((await merge('A01', 'A02')).status).toBe(201);
    expect(
      await sessionModel
        .countDocuments({
          tableIds: { $in: [table('A01')._id, table('A02')._id] },
        })
        .exec(),
    ).toBe(before);
    const [a01Grouped, a02Grouped] = await Promise.all([
      tableModel.findById(table('A01').id).lean().exec(),
      tableModel.findById(table('A02').id).lean().exec(),
    ]);
    expect(a01Grouped!.groupedWithTableIds.map(String)).toContain(
      table('A02').id,
    );
    expect(a02Grouped!.groupedWithTableIds.map(String)).toContain(
      table('A01').id,
    );
    const qr = await active('A01');
    expect(new Set(qr.tableIds)).toEqual(
      new Set([table('A01').id, table('A02').id]),
    );
    log('Case 1 DB after QR', {
      session: await sessionModel.findById(qr.sessionId).lean().exec(),
      tables: await tableModel
        .find({ _id: { $in: [table('A01')._id, table('A02')._id] } })
        .lean()
        .exec(),
    });
  });

  it('lists and safely separates an Available table group without treating occupied A05 as merged', async () => {
    expect((await merge('A01', 'A02')).status).toBe(201);
    await active('A05');

    const options = await request(app.getHttpServer())
      .get('/sessions/table-operation-options')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(options.body.unmergeGroups).toEqual([
      expect.objectContaining({
        kind: 'table_group',
        displayName: 'Nhóm A01 + A02',
        tableIds: expect.arrayContaining([table('A01').id, table('A02').id]),
      }),
    ]);
    expect(options.body.unmergeGroups[0].tableIds).not.toContain(
      table('A05').id,
    );

    await request(app.getHttpServer())
      .post('/sessions/unmerge')
      .set('Authorization', `Bearer ${token}`)
      .send({ tableId: table('A01').id })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({ case: 'ungrouped', status: 'available' });
      });
    const separated = await tableModel
      .find({ _id: { $in: [table('A01')._id, table('A02')._id] } })
      .exec();
    expect(separated).toHaveLength(2);
    separated.forEach((member) => {
      expect(member.groupedWithTableIds).toHaveLength(0);
      expect(member.currentSessionId).toBeNull();
      expect(member.status).toBe(TableStatus.AVAILABLE);
    });
  });

  it('Case 2: adds an available table to the existing session and preserves its cart/order', async () => {
    await merge('A01', 'A02');
    const s1 = await active('A01');
    await addCart(s1.sessionId, 0, 1);
    await createOrder('A01');
    await addCart(s1.sessionId, 1, 2);
    expect((await merge('A01', 'A03')).status).toBe(201);
    const [root, a03, qrA03] = await Promise.all([
      sessionModel.findById(s1.sessionId).lean().exec(),
      tableModel.findById(table('A03').id).lean().exec(),
      active('A03'),
    ]);
    expect(root!.tableIds.map(String)).toEqual(
      expect.arrayContaining([
        table('A01').id,
        table('A02').id,
        table('A03').id,
      ]),
    );
    expect(a03!.currentSessionId!.toString()).toBe(s1.sessionId);
    expect(qrA03.sessionId).toBe(s1.sessionId);
    expect(qrA03.cart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dishId: dishes[1].id, quantity: 2 }),
      ]),
    );
    expect(
      await orderModel
        .countDocuments({
          sessionId: new Types.ObjectId(s1.sessionId),
          tableId: table('A01')._id,
        })
        .exec(),
    ).toBe(1);
    log('Case 2 DB after merge', {
      root,
      a03,
      orders: await orderModel.find({ sessionId: s1.sessionId }).lean().exec(),
    });
  });

  it('Case 3 + unmerge: merges carts/orders, restores exactly A05, and blocks unmerge after a new shared order', async () => {
    const [s2, s3] = await Promise.all([active('A04'), active('A05')]);
    await addCart(s2.sessionId, 0, 1);
    await createOrder('A04');
    await addCart(s2.sessionId, 0, 2);
    await addCart(s3.sessionId, 1, 1);
    await createOrder('A05');
    await addCart(s3.sessionId, 0, 3);
    expect((await merge('A04', 'A05')).status).toBe(201);
    const [root, child, sourceOrder, a05] = await Promise.all([
      sessionModel.findById(s2.sessionId).lean().exec(),
      sessionModel.findById(s3.sessionId).lean().exec(),
      orderModel
        .findOne({ tableId: table('A05')._id })
        .lean()
        .exec(),
      tableModel.findById(table('A05').id).lean().exec(),
    ]);
    expect(root!.cart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dishId: dishes[0]._id, quantity: 5 }),
      ]),
    );
    expect(sourceOrder!.tableId.toString()).toBe(table('A05').id);
    expect(sourceOrder!.sessionId.toString()).toBe(s2.sessionId);
    expect(child!.status).toBe(SessionStatus.MERGED);
    expect(child!.mergedIntoSessionId!.toString()).toBe(s2.sessionId);
    expect(a05!.currentSessionId!.toString()).toBe(s2.sessionId);
    log('Case 3 DB after merge', { root, child, sourceOrder, a05 });

    const unmerge = await request(app.getHttpServer())
      .post('/sessions/unmerge')
      .set('Authorization', `Bearer ${token}`)
      .send({ tableId: table('A05').id })
      .expect(201);
    log('unmerge A05 response', unmerge.body);
    const [restored, restoredTable] = await Promise.all([
      sessionModel.findById(s3.sessionId).lean().exec(),
      tableModel.findById(table('A05').id).lean().exec(),
    ]);
    expect(restored!.status).toBe(SessionStatus.ACTIVE);
    expect(restoredTable!.currentSessionId!.toString()).toBe(s3.sessionId);

    expect((await merge('A04', 'A05')).status).toBe(201);
    await addCart(s2.sessionId, 1, 1);
    await createOrder('A04');
    const blocked = await request(app.getHttpServer())
      .post('/sessions/unmerge')
      .set('Authorization', `Bearer ${token}`)
      .send({ tableId: table('A05').id })
      .expect(400);
    log('blocked unmerge after shared order', blocked.body);
    expect(String(blocked.body.message)).toContain('đơn hàng chung');
  }, 30_000);

  it('lists merge groups once, lists only audited unmerge groups, and rejects self/duplicate merge', async () => {
    await Promise.all([active('A01'), active('A02'), active('A05')]);
    expect((await merge('A01', 'A02')).status).toBe(201);

    const options = await request(app.getHttpServer())
      .get('/sessions/table-operation-options')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const mergedCandidates = options.body.mergeCandidates.filter(
      (candidate: { tableIds: string[] }) =>
        candidate.tableIds.includes(table('A01').id) ||
        candidate.tableIds.includes(table('A02').id),
    );
    expect(mergedCandidates).toHaveLength(1);
    expect(new Set(mergedCandidates[0].tableIds)).toEqual(
      new Set([table('A01').id, table('A02').id]),
    );
    expect(options.body.unmergeGroups).toHaveLength(1);
    expect(options.body.unmergeGroups[0].displayName).toContain('A01 + A02');
    expect(options.body.unmergeGroups[0].tableIds).not.toContain(
      table('A05').id,
    );

    expect((await merge('A01', 'A02')).status).toBe(400);
    const selfMerge = await request(app.getHttpServer())
      .post('/sessions/merge-tables')
      .set('Authorization', `Bearer ${token}`)
      .send({ tableIds: [table('A01').id, table('A01').id] });
    expect(selfMerge.status).toBe(400);
  });

  it('rejects unmerge when the shared cart changed after mergedAt without losing items', async () => {
    const [root, child] = await Promise.all([active('A04'), active('A05')]);
    expect((await merge('A04', 'A05')).status).toBe(201);
    await addCart(root.sessionId, 0, 2);

    const blocked = await request(app.getHttpServer())
      .post('/sessions/unmerge')
      .set('Authorization', `Bearer ${token}`)
      .send({ childSessionId: child.sessionId })
      .expect(400);
    expect(String(blocked.body.message)).toContain('giỏ hàng chung');
    const unchangedRoot = await sessionModel.findById(root.sessionId).exec();
    expect(unchangedRoot?.cart).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dishId: dishes[0]._id, quantity: 2 }),
      ]),
    );
  });

  it('resolves a merge chain to the final root session', async () => {
    const [sa, sb, sc] = await Promise.all([
      active('A01'),
      active('A02'),
      active('A03'),
    ]);
    expect((await merge('A02', 'A01')).status).toBe(201); // SA -> SB
    expect((await merge('A03', 'A02')).status).toBe(201); // SB -> SC
    const [afterA, afterB] = await Promise.all([
      sessionModel.findById(sa.sessionId).lean().exec(),
      sessionModel.findById(sb.sessionId).lean().exec(),
    ]);
    expect(afterA!.mergedIntoSessionId!.toString()).toBe(sc.sessionId);
    expect(afterB!.mergedIntoSessionId!.toString()).toBe(sc.sessionId);
    log('merge chain DB', {
      sa: afterA,
      sb: afterB,
      sc: await sessionModel.findById(sc.sessionId).lean().exec(),
    });
  });

  it('rejects one of two concurrent merges that share table A02', async () => {
    await Promise.all([active('A01'), active('A02'), active('A03')]);
    const results = await Promise.all([
      request(app.getHttpServer())
        .post('/sessions/merge-tables')
        .set('Authorization', `Bearer ${token}`)
        .send({ tableIds: [table('A01').id, table('A02').id] }),
      request(app.getHttpServer())
        .post('/sessions/merge-tables')
        .set('Authorization', `Bearer ${token}`)
        .send({ tableIds: [table('A03').id, table('A02').id] }),
    ]);
    log(
      'race request responses',
      results.map((result) => ({ status: result.status, body: result.body })),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status !== 201)).toHaveLength(1);
    expect(
      results.find((result) => result.status !== 201)!.status,
    ).toBeGreaterThanOrEqual(400);
    const a02 = await tableModel.findById(table('A02').id).lean().exec();
    const owners = await sessionModel
      .find({ status: SessionStatus.ACTIVE, tableIds: table('A02')._id })
      .lean()
      .exec();
    expect(owners).toHaveLength(1);
    expect(a02!.currentSessionId!.toString()).toBe(owners[0]._id.toString());
    log('race DB ownership', { a02, owners });
  });
});
