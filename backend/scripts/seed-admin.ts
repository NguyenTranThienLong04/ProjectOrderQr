/*
  Simple seed script to populate dishes, tables and orders for admin dashboard testing.
  Run with: npx ts-node scripts/seed-admin.ts (or npm run seed:admin after adding script)
*/
import 'dotenv/config';
import mongoose from 'mongoose';
import { OrderSchema, Order } from '../src/modules/order/order.schema';
import { DishSchema, Dish } from '../src/modules/dish/dish.schema';
import { TableSchema, Table } from '../src/modules/table/table.schema';
import { CategorySchema } from '../src/modules/category/category.schema';
import { SessionSchema } from '../src/modules/session/session.schema';
import { SessionStatus } from '../src/common/enums/session-status.enum';
import { OrderStatus } from '../src/common/enums/order-status.enum';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Please set MONGODB_URI in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const DishModel = mongoose.model<Dish & mongoose.Document>('Dish', DishSchema);
  const TableModel = mongoose.model<Table & mongoose.Document>('Table', TableSchema);
  const OrderModel = mongoose.model<Order & mongoose.Document>('Order', OrderSchema);
  const CategoryModel = mongoose.model('Category', CategorySchema);

  // Clear minimal collections to avoid duplicates in repeated runs (only for dev)
  await Promise.all([
    CategoryModel.deleteMany({}),
    DishModel.deleteMany({}),
    TableModel.deleteMany({}),
    OrderModel.deleteMany({}),
  ]);

  console.log('Cleared Category/Dish/Table/Order collections (dev-only)');

  // Create a default category for dishes (Dish.categoryId is required)
  const defaultCategory = await CategoryModel.create({ name: 'General', description: 'Auto-created category for seed data' });

  // Create sample dishes
  const dishes = [] as any[];
  for (let i = 1; i <= 20; i++) {
    dishes.push(
      new DishModel({
        name: `Dish ${i}`,
        price: Math.round(20000 + Math.random() * 180000),
        description: `Delicious Dish ${i}`,
        categoryId: defaultCategory._id,
      }),
    );
  }
  await DishModel.insertMany(dishes);
  console.log('Inserted', dishes.length, 'dishes');

  // Create tables
  const tables = [] as any[];
  for (let i = 1; i <= 20; i++) {
    tables.push(
      new TableModel({
        tableCode: `T${i}`,
        status: i % 5 === 0 ? 'occupied' : 'available',
        qrCodeUrl: `https://example.com/qrcode/T${i}`,
        capacity: 4,
      }),
    );
  }
  await TableModel.insertMany(tables);
  console.log('Inserted', tables.length, 'tables');

  // Create sessions (one per table) so orders can reference sessionId (required)
  const SessionModel = mongoose.model('Session', SessionSchema);
  const sessions = [] as any[];
  for (const t of tables) {
    const s = await SessionModel.create({ tableId: t._id, status: SessionStatus.ACTIVE, cart: [], version: 0, startedAt: new Date() });
    sessions.push(s);
  }

  // Create many orders across a date range
  const statuses = [OrderStatus.PAID, OrderStatus.CANCELLED, OrderStatus.PENDING, OrderStatus.SERVED];
  const now = new Date();
  const ordersToCreate = 800; // generate a few hundred orders
  const orders = [] as any[];

  for (let i = 0; i < ordersToCreate; i++) {
    // random date in last 90 days
    const daysAgo = Math.floor(Math.random() * 90);
    const createdAt = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000 - Math.floor(Math.random() * 86400000));

    // pick random status, bias toward Paid
    const status = Math.random() < 0.6 ? OrderStatus.PAID : statuses[Math.floor(Math.random() * statuses.length)];

    // pick random session (and its table)
    const session = sessions[Math.floor(Math.random() * sessions.length)];
    const table = tables.find((t) => String(t._id) === String(session.tableId)) || tables[Math.floor(Math.random() * tables.length)];

    // create random items
    const itemCount = 1 + Math.floor(Math.random() * 4);
    const items = [] as any[];
    let totalAmount = 0;
    for (let j = 0; j < itemCount; j++) {
      const dish = dishes[Math.floor(Math.random() * dishes.length)];
      const qty = 1 + Math.floor(Math.random() * 3);
      const unitPrice = dish.price;
      totalAmount += unitPrice * qty;
      items.push({
        dishId: dish._id,
        dishName: dish.name,
        unitPrice,
        quantity: qty,
        status: status === OrderStatus.PAID ? OrderStatus.PAID : OrderStatus.PENDING,
        statusHistory: [],
      });
    }

    const doc: any = {
      sessionId: session._id,
      tableId: table._id,
      items,
      status,
      statusHistory: [],
      totalAmount,
      note: '',
      createdAt,
      updatedAt: createdAt,
    };

    if (status === OrderStatus.PAID) {
      // paidAt sometime after createdAt
      const paidAt = new Date(createdAt.getTime() + Math.floor(Math.random() * 6) * 3600 * 1000);
      doc.paidAt = paidAt;
    }

    orders.push(doc);
  }

  await OrderModel.insertMany(orders);
  console.log('Inserted', orders.length, 'orders');

  await mongoose.disconnect();
  console.log('Disconnected, seed finished');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
