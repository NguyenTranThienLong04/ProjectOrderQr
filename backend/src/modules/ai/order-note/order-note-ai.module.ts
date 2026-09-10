import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Dish, DishSchema } from '../../dish/dish.schema';
import { Session, SessionSchema } from '../../session/session.schema';
import { Table, TableSchema } from '../../table/table.schema';
import { AiModule } from '../ai.module';
import { createAiRateLimiter } from '../ai-rate-limit';
import { OrderNoteAiController } from './order-note-ai.controller';
import { OrderNoteAiService } from './order-note-ai.service';
@Module({
  imports: [
    AiModule,
    MongooseModule.forFeature([
      { name: Dish.name, schema: DishSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Table.name, schema: TableSchema },
    ]),
  ],
  controllers: [OrderNoteAiController],
  providers: [OrderNoteAiService],
})
export class OrderNoteAiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(createAiRateLimiter()).forRoutes({
      path: 'ai/order-notes/analyze',
      method: RequestMethod.POST,
    });
  }
}
