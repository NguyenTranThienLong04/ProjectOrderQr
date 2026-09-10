import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { AdminModule } from '../../admin/admin.module';
import { AiModule } from '../ai.module';
import { createAiRateLimiter } from '../ai-rate-limit';
import { AdminAnalyticsAiController } from './admin-analytics-ai.controller';
import { AdminAnalyticsAiService } from './admin-analytics-ai.service';
import { AnalyticsToolsService } from './analytics-tools.service';

@Module({
  imports: [AiModule, AdminModule],
  controllers: [AdminAnalyticsAiController],
  providers: [AdminAnalyticsAiService, AnalyticsToolsService],
})
export class AdminAnalyticsAiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(createAiRateLimiter()).forRoutes({
      path: 'ai/admin/analytics/query',
      method: RequestMethod.POST,
    });
  }
}
