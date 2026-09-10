import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { MenuModule } from '../../menu/menu.module';
import { AiModule } from '../ai.module';
import { createAiRateLimiter } from '../ai-rate-limit';
import { MenuSearchAiController } from './menu-search-ai.controller';
import { MenuSearchAiService } from './menu-search-ai.service';
@Module({
  imports: [AiModule, MenuModule],
  controllers: [MenuSearchAiController],
  providers: [MenuSearchAiService],
})
export class MenuSearchAiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(createAiRateLimiter())
      .forRoutes({ path: 'ai/menu/search', method: RequestMethod.POST });
  }
}
