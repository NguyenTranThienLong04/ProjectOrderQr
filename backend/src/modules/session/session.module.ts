import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Session, SessionSchema } from './session.schema';
import { Table, TableSchema } from '../table/table.schema';
import { Dish, DishSchema } from '../dish/dish.schema';
import { Order, OrderSchema } from '../order/order.schema';
import { SessionController } from './session.controller';
import { SessionService } from './session.service';
import { GatewayModule } from '../../gateway/gateway.module';
import { AbandonedSessionCleanupService } from './abandoned-session-cleanup.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Table.name, schema: TableSchema },
      { name: Dish.name, schema: DishSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    forwardRef(() => GatewayModule),
  ],
  controllers: [SessionController],
  providers: [SessionService, AbandonedSessionCleanupService],
  exports: [MongooseModule, SessionService, AbandonedSessionCleanupService],
})
export class SessionModule {}
