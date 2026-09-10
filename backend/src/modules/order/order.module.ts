import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from './order.schema';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { OrderStateMachineService } from './order-state-machine.service';
import { Table, TableSchema } from '../table/table.schema';
import { Session, SessionSchema } from '../session/session.schema';
import { Dish, DishSchema } from '../dish/dish.schema';
import { SessionModule } from '../session/session.module';
import { GatewayModule } from '../../gateway/gateway.module';
import { PromotionModule } from '../promotion/promotion.module';
import { InvoiceModule } from '../invoice/invoice.module';

@Module({
  imports: [
    InvoiceModule,
    SessionModule,
    GatewayModule,
    PromotionModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Table.name, schema: TableSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Dish.name, schema: DishSchema },
    ]),
  ],
  controllers: [OrderController],
  providers: [OrderService, OrderStateMachineService],
  exports: [MongooseModule, OrderStateMachineService, InvoiceModule],
})
export class OrderModule {}
