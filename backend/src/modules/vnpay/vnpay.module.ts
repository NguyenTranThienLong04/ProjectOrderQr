import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GatewayModule } from '../../gateway/gateway.module';
import { OrderModule } from '../order/order.module';
import { Order, OrderSchema } from '../order/order.schema';
import { Session, SessionSchema } from '../session/session.schema';
import { Table, TableSchema } from '../table/table.schema';
import { PaymentIntent, PaymentIntentSchema } from './payment-intent.schema';
import { VnpayController } from './vnpay.controller';
import { VnpayService } from './vnpay.service';

@Module({
  imports: [
    OrderModule,
    GatewayModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Table.name, schema: TableSchema },
      { name: PaymentIntent.name, schema: PaymentIntentSchema },
    ]),
  ],
  controllers: [VnpayController],
  providers: [VnpayService],
})
export class VnpayModule {}
