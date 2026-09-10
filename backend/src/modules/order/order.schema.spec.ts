import { model, Types } from 'mongoose';
import { OrderSchema } from './order.schema';

const SnapshotOrder = model('ProgressSnapshotOrder', OrderSchema);

describe('Order item display snapshots', () => {
  it.each([{}, { nameEn: 'Beef fried rice', imageUrl: '/rice.jpg' }])(
    'accepts and persists both legacy and enriched items: %j',
    async (display) => {
      const order = new SnapshotOrder({
        sessionId: new Types.ObjectId(),
        tableId: new Types.ObjectId(),
        items: [
          {
            dishId: new Types.ObjectId(),
            dishName: 'Cơm chiên bò',
            unitPrice: 50_000,
            quantity: 2,
            ...display,
          },
        ],
      });
      await expect(order.validate()).resolves.toBeUndefined();
      const item = order.toObject().items[0];
      expect(item).toMatchObject({
        dishName: 'Cơm chiên bò',
        unitPrice: 50_000,
        quantity: 2,
        ...display,
      });
      expect(item.nameEn).toBe(display.nameEn);
      expect(item.imageUrl).toBe(display.imageUrl);
    },
  );
});
