import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PromotionController } from './promotion.controller';
import { Promotion, PromotionSchema } from './promotion.schema';
import { PromotionService } from './promotion.service';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [
    SessionModule,
    MongooseModule.forFeature([
      { name: Promotion.name, schema: PromotionSchema },
    ]),
  ],
  controllers: [PromotionController],
  providers: [PromotionService],
  exports: [PromotionService],
})
export class PromotionModule {}
