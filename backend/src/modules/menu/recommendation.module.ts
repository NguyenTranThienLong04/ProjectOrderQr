import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Order, OrderSchema } from '../order/order.schema';
import { Session, SessionSchema } from '../session/session.schema';
import { Table, TableSchema } from '../table/table.schema';
import { MenuModule } from './menu.module';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';

@Module({
  imports: [
    MenuModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Table.name, schema: TableSchema },
    ]),
  ],
  controllers: [RecommendationController],
  providers: [RecommendationService],
})
export class RecommendationModule {}
