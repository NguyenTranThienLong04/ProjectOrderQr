import 'dotenv/config';
import * as dns from 'dns';
import mongoose from 'mongoose';
import {
  Category,
  CategorySchema,
} from '../src/modules/category/category.schema';
import { Dish, DishSchema } from '../src/modules/dish/dish.schema';
import { Order, OrderSchema } from '../src/modules/order/order.schema';
import { Session, SessionSchema } from '../src/modules/session/session.schema';
import { Table, TableSchema } from '../src/modules/table/table.schema';
import { TableStatus } from '../src/common/enums/table-status.enum';

const tableCodes = ['A01', 'A02', 'A03', 'A04', 'A05'];
const categoryName = '__phase7_merge_test__';
const dishNames = ['__phase7_merge_dish_1__', '__phase7_merge_dish_2__'];

// Keep CLI behavior aligned with main.ts without changing DNS unless this
// machine explicitly opted in through its local .env.
if (process.env.CUSTOM_DNS_SERVERS) {
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
  console.warn(
    `[seed:merge-test] Using custom DNS servers: ${process.env.CUSTOM_DNS_SERVERS}`,
  );
}

export async function seedMergeTestData(connection: typeof mongoose) {
  const CategoryModel =
    connection.models.Category ??
    connection.model(Category.name, CategorySchema);
  const DishModel =
    connection.models.Dish ?? connection.model(Dish.name, DishSchema);
  const TableModel =
    connection.models.Table ?? connection.model(Table.name, TableSchema);
  const SessionModel =
    connection.models.Session ?? connection.model(Session.name, SessionSchema);
  const OrderModel =
    connection.models.Order ?? connection.model(Order.name, OrderSchema);

  const oldTables = await TableModel.find({ tableCode: { $in: tableCodes } })
    .select('_id')
    .lean()
    .exec();
  const oldTableIds = oldTables.map((table) => table._id);
  const oldSessions = await SessionModel.find({
    $or: [
      { tableId: { $in: oldTableIds } },
      { tableIds: { $in: oldTableIds } },
      { preMergeTableIds: { $in: oldTableIds } },
    ],
  })
    .select('_id')
    .lean()
    .exec();
  await OrderModel.deleteMany({
    $or: [
      { tableId: { $in: oldTableIds } },
      { sessionId: { $in: oldSessions.map((session) => session._id) } },
    ],
  }).exec();
  await SessionModel.deleteMany({
    _id: { $in: oldSessions.map((session) => session._id) },
  }).exec();
  await TableModel.deleteMany({ _id: { $in: oldTableIds } }).exec();
  await DishModel.deleteMany({ name: { $in: dishNames } }).exec();

  let category = await CategoryModel.findOne({ name: categoryName }).exec();
  if (!category)
    category = await CategoryModel.create({
      name: categoryName,
      description: 'Isolated fixtures for Phase 7 merge tests',
      isActive: true,
    });
  const tables = await TableModel.insertMany(
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
  const dishes = await DishModel.insertMany([
    {
      name: dishNames[0],
      description: 'Phase 7 test dish 1',
      price: 45000,
      categoryId: category._id,
      isAvailable: true,
    },
    {
      name: dishNames[1],
      description: 'Phase 7 test dish 2',
      price: 55000,
      categoryId: category._id,
      isAvailable: true,
    },
  ]);
  return {
    tables: new Map(tables.map((table) => [table.tableCode, table])),
    dishes,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required in backend/.env');
  await mongoose.connect(uri);
  const data = await seedMergeTestData(mongoose);
  console.log(
    JSON.stringify(
      {
        seededTables: [...data.tables.keys()],
        dishIds: data.dishes.map((dish) => dish.id),
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error);
    await mongoose.disconnect();
    process.exit(1);
  });
}
