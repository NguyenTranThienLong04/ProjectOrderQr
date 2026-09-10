import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Category, CategorySchema } from '../../category/category.schema';
import { AiModule } from '../ai.module';
import { createAiRateLimiter } from '../ai-rate-limit';
import { CatalogDraftAiController } from './catalog-draft-ai.controller';
import { CatalogDraftAiService } from './catalog-draft-ai.service';

@Module({
  imports: [
    AiModule,
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
    ]),
  ],
  controllers: [CatalogDraftAiController],
  providers: [CatalogDraftAiService],
})
export class CatalogDraftAiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(createAiRateLimiter())
      .forRoutes({ path: 'ai/admin/dish-draft', method: RequestMethod.POST });
  }
}
