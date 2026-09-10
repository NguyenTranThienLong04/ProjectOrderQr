import { OrderNoteAiModule } from './modules/ai/order-note/order-note-ai.module';
import { MenuSearchAiModule } from './modules/ai/menu-search/menu-search-ai.module';
import { AdminAnalyticsAiModule } from './modules/ai/admin-analytics/admin-analytics-ai.module';
import { ReviewIntelligenceModule } from './modules/ai/review-intelligence/review-intelligence.module';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { GatewayModule } from './gateway/gateway.module';
import { SchemasModule } from './modules/schemas.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { MenuModule } from './modules/menu/menu.module';
import { RecommendationModule } from './modules/menu/recommendation.module';
import { AdminModule } from './modules/admin/admin.module';
import { VnpayModule } from './modules/vnpay/vnpay.module';
import { ReviewModule } from './modules/review/review.module';
import { AiModule } from './modules/ai/ai.module';
import { CatalogDraftAiModule } from './modules/ai/catalog-draft/catalog-draft-ai.module';

// ServeStaticModule đã được gỡ bỏ: ảnh Dish nay lưu trên Cloudinary (Phase 2 bổ sung).
// Ảnh local cũ của Panacota là data test, không có xử lý migrate riêng.

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    SchemasModule,
    UserModule,
    AuthModule,
    MenuModule,
    RecommendationModule,
    GatewayModule,
    AdminModule,
    VnpayModule,
    ReviewModule,
    AiModule,
    CatalogDraftAiModule,
    OrderNoteAiModule,
    MenuSearchAiModule,
    AdminAnalyticsAiModule,
    ReviewIntelligenceModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
