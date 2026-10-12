import {
  testMongoUri,
  clearTestCollections,
} from '../../../test/support/test-database';
import { Connection, createConnection, Types } from 'mongoose';
import { TableStatus } from '../../common/enums/table-status.enum';
import { Dish, DishSchema } from '../dish/dish.schema';
import { Promotion, PromotionSchema } from '../promotion/promotion.schema';
import { PromotionType } from '../promotion/promotion-type.enum';
import { PromotionService } from '../promotion/promotion.service';
import { Session, SessionSchema } from '../session/session.schema';
import { SessionService } from '../session/session.service';
import { Table, TableSchema } from '../table/table.schema';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderController } from './order.controller';
import { Order, OrderSchema } from './order.schema';
import { OrderService } from './order.service';

// Database lifecycle is owned by the shared integration harness.

describe(
  'Create order transaction regressions (isolated MongoDB)',
  () => {
    const connections: Connection[] = [];
    let first: ReturnType<typeof instance>;
    let second: ReturnType<typeof instance>;
    let dto: CreateOrderDto;
    let tableId: Types.ObjectId;
    let sessionId: Types.ObjectId;
    let dishId: Types.ObjectId;

    const gateway = {
      synchronizeSession: jest.fn(),
      emitOrderUpdated: jest.fn(),
      emit: jest.fn(),
    };

    function instance(connection: Connection) {
      const orders = connection.model(Order.name, OrderSchema);
      const tables = connection.model(Table.name, TableSchema);
      const dishes = connection.model(Dish.name, DishSchema);
      const sessions = connection.model(Session.name, SessionSchema);
      const promotions = connection.model(Promotion.name, PromotionSchema);
      const sessionService = new SessionService(
        sessions,
        tables,
        dishes,
        orders,
        connection,
        {} as never,
      );
      const service = new OrderService(
        orders,
        tables,
        dishes,
        sessions,
        sessionService,
        new PromotionService(promotions),
        {} as never,
      );
      const controller = new OrderController(
        service,
        gateway as never,
        {} as never,
        {} as never,
      );
      return {
        orders,
        tables,
        dishes,
        sessions,
        promotions,
        sessionService,
        service,
        controller,
      };
    }

    beforeAll(async () => {
      const uri = testMongoUri();
      const connection = createConnection(uri);
      connections.push(connection);
      await connection.asPromise();
      first = instance(connection);
      const otherConnection = createConnection(uri);
      connections.push(otherConnection);
      await otherConnection.asPromise();
      second = instance(otherConnection);
      await Promise.all(
        connections.flatMap((conn) =>
          Object.values(conn.models).map((model) => model.init()),
        ),
      );
      await first.service.onModuleInit();
      await second.service.onModuleInit();
    }, 45000);

    afterAll(async () => {
      jest.restoreAllMocks();
      // Connections belong only to this suite database.
      await Promise.all(connections.map((connection) => connection.close()));
    }, 15000);

    beforeEach(async () => {
      jest.restoreAllMocks();
      jest.clearAllMocks();
      // Only the fresh, privately spawned test server is ever modified.
      await clearTestCollections(connections[0]);
      tableId = new Types.ObjectId();
      sessionId = new Types.ObjectId();
      dishId = new Types.ObjectId();
      await first.dishes.create({
        _id: dishId,
        name: 'Rice',
        price: 10000,
        categoryId: new Types.ObjectId(),
      });
      await first.sessions.create({
        _id: sessionId,
        tableId,
        tableIds: [tableId],
        version: 0,
        cart: [{ dishId, dishName: 'Rice', unitPrice: 10000, quantity: 2 }],
      });
      await first.tables.create({
        _id: tableId,
        tableCode: 'ATOMIC',
        qrCodeUrl: 'test',
        currentSessionId: sessionId,
        status: TableStatus.WAITING_PAYMENT,
      });
      await first.promotions.create({
        code: 'SAVE10',
        type: PromotionType.PERCENTAGE,
        value: 10,
        startDate: new Date('2020-01-01'),
        endDate: new Date('2100-01-01'),
        usageLimit: 1,
      });
      dto = {
        tableId: tableId.toString(),
        sessionId: sessionId.toString(),
        cartVersion: 0,
        idempotencyKey: `${sessionId}:0`,
        promotionCode: 'SAVE10',
      };
      // Read from a separate connection at the first event to prove commit precedes emission.
      gateway.synchronizeSession.mockImplementation(async () => {
        expect(await second.orders.countDocuments()).toBe(1);
        expect((await second.sessions.findById(sessionId))!.cart).toHaveLength(0);
        expect((await second.tables.findById(tableId))!.status).toBe(
          TableStatus.OCCUPIED,
        );
        expect((await second.promotions.findOne())!.usedCount).toBe(1);
      });
    });

    it('rolls back cart, order, promotion and table on a late failure; only commit emits', async () => {
      const original = first.tables.updateMany.bind(first.tables);
      const failure = jest
        .spyOn(first.tables, 'updateMany')
        .mockImplementationOnce((...args: any[]) => {
          const query = original(...args);
          const execute = query.exec.bind(query);
          query.exec = async () => {
            await execute(); // Fail AFTER the final write has actually run in MongoDB.
            throw new Error('injected failure after table update');
          };
          return query;
        });
      const before = (await first.sessions.findById(sessionId))!.toObject();
      await expect(first.controller.create(dto)).rejects.toThrow(
        'injected failure',
      );
      expect((await first.sessions.findById(sessionId))!.toObject()).toEqual(
        before,
      );
      expect(await first.orders.countDocuments()).toBe(0);
      expect((await first.promotions.findOne())!.usedCount).toBe(0);
      expect((await first.tables.findById(tableId))!.status).toBe(
        TableStatus.WAITING_PAYMENT,
      );
      expect(gateway.synchronizeSession).not.toHaveBeenCalled();
      expect(gateway.emitOrderUpdated).not.toHaveBeenCalled();
      expect(gateway.emit).not.toHaveBeenCalled();
      failure.mockRestore();
      await first.controller.create(dto);
      expect(gateway.emitOrderUpdated).toHaveBeenCalledTimes(1);
      expect(gateway.emit).toHaveBeenCalledTimes(1);
    });

    it('replays the persisted order from another instance without consuming a newer cart', async () => {
      const created = await first.controller.create(dto);
      await first.sessions.updateOne(
        { _id: sessionId },
        {
          $set: {
            cart: [{ dishId, dishName: 'Rice', unitPrice: 10000, quantity: 3 }],
          },
          $inc: { version: 1 },
        },
      );
      expect(await second.controller.create(dto)).toEqual(created);
      expect(await first.orders.countDocuments()).toBe(1);
      expect((await first.sessions.findById(sessionId))!.cart[0].quantity).toBe(
        3,
      );
      expect((await first.promotions.findOne())!.usedCount).toBe(1);
      expect(gateway.synchronizeSession).toHaveBeenCalledTimes(1);
      expect(gateway.emitOrderUpdated).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])(
      'concurrent requests for one cart (same key: %s) create at most one order',
      async (sameKey) => {
        let arrivals = 0;
        let release!: () => void;
        const barrier = new Promise<void>((done) => {
          release = done;
        });
        for (const app of [first, second]) {
          const consume = app.sessionService.consumeCartForOrder.bind(
            app.sessionService,
          );
          jest
            .spyOn(app.sessionService, 'consumeCartForOrder')
            .mockImplementation(async (...args) => {
              arrivals++;
              if (arrivals === 2) release();
              await barrier; // Both transactions have already read "no existing order".
              return consume(...args);
            });
        }
        const results = await Promise.allSettled([
          first.controller.create(dto),
          second.controller.create({
            ...dto,
            idempotencyKey: sameKey ? dto.idempotencyKey : 'different-key',
          }),
        ]);
        const successes = results.filter(
          (result) => result.status === 'fulfilled',
        );
        expect(successes).toHaveLength(sameKey ? 2 : 1);
        if (sameKey) expect(successes[0].value).toEqual(successes[1].value);
        expect(await first.orders.countDocuments()).toBe(1);
        expect((await first.sessions.findById(sessionId))!.cart).toHaveLength(0);
        expect((await first.sessions.findById(sessionId))!.version).toBe(1);
        expect((await first.promotions.findOne())!.usedCount).toBe(1);
        expect(gateway.synchronizeSession).toHaveBeenCalledTimes(1);
        expect(gateway.emitOrderUpdated).toHaveBeenCalledTimes(1);
        expect(gateway.emit).toHaveBeenCalledTimes(1);
      },
      15000,
    );

    it('the unique key also prevents a race across independent carts and preserves the losing cart', async () => {
      const otherTableId = new Types.ObjectId();
      const otherSessionId = new Types.ObjectId();
      await first.sessions.create({
        _id: otherSessionId,
        tableId: otherTableId,
        tableIds: [otherTableId],
        cart: [{ dishId, dishName: 'Rice', unitPrice: 10000, quantity: 1 }],
      });
      await first.tables.create({
        _id: otherTableId,
        tableCode: 'OTHER',
        qrCodeUrl: 'test',
        currentSessionId: otherSessionId,
        status: TableStatus.WAITING_PAYMENT,
      });
      let arrivals = 0;
      let release!: () => void;
      const barrier = new Promise<void>((done) => {
        release = done;
      });
      for (const app of [first, second]) {
        const consume = app.sessionService.consumeCartForOrder.bind(
          app.sessionService,
        );
        jest
          .spyOn(app.sessionService, 'consumeCartForOrder')
          .mockImplementation(async (...args) => {
            if (++arrivals === 2) release();
            await barrier;
            return consume(...args);
          });
      }
      gateway.synchronizeSession.mockImplementation(async (id: string) => {
        expect(await second.orders.countDocuments()).toBe(1);
        expect((await second.sessions.findById(id))!.cart).toHaveLength(0);
      });
      // No shared promotion: the unique Order index is the only contested write.
      const results = await Promise.allSettled([
        first.controller.create({ ...dto, promotionCode: undefined }),
        second.controller.create({
          ...dto,
          tableId: otherTableId.toString(),
          sessionId: otherSessionId.toString(),
          promotionCode: undefined,
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected')!;
      expect(rejected.reason.getStatus()).toBe(409);
      const loser = results[0].status === 'rejected' ? sessionId : otherSessionId;
      expect(await first.orders.countDocuments()).toBe(1);
      expect((await first.sessions.findById(loser))!.cart).toHaveLength(1);
      expect((await first.sessions.findById(loser))!.version).toBe(0);
      expect(
        (await first.tables.findOne({ currentSessionId: loser }))!.status,
      ).toBe(TableStatus.WAITING_PAYMENT);
      expect((await first.promotions.findOne())!.usedCount).toBe(0);
      expect(gateway.emitOrderUpdated).toHaveBeenCalledTimes(1);
    }, 15000);
  },
);
