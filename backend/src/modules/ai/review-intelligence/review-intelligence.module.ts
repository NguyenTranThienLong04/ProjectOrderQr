import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ReviewModule } from '../../review/review.module';
import { AiModule } from '../ai.module';
import { createAiRateLimiter } from '../ai-rate-limit';
import { ReviewIntelligenceController } from './review-intelligence.controller';
import { ReviewIntelligenceService } from './review-intelligence.service';

@Module({
  imports: [AiModule, ReviewModule],
  controllers: [ReviewIntelligenceController],
  providers: [ReviewIntelligenceService],
})
export class ReviewIntelligenceModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(createAiRateLimiter()).forRoutes(
      {
        path: 'ai/admin/review-insights/analyze',
        method: RequestMethod.POST,
      },
      {
        path: 'ai/admin/review-insights/summary',
        method: RequestMethod.POST,
      },
    );
  }
}
