import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Table, TableSchema } from './table.schema';
import { TableService } from './table.service';
import { TableController } from './table.controller';
import { ConfigModule } from '@nestjs/config';
import { Session, SessionSchema } from '../session/session.schema';
import { GatewayModule } from '../../gateway/gateway.module';
import { Order, OrderSchema } from '../order/order.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Table.name, schema: TableSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
    ConfigModule,
    GatewayModule,
  ],
  controllers: [TableController],
  providers: [TableService],
  exports: [MongooseModule, TableService],
})
export class TableModule {}
