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
import { AdminModule } from './modules/admin/admin.module';
import { VnpayModule } from './modules/vnpay/vnpay.module';
import { ReviewModule } from './modules/review/review.module';

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
    GatewayModule,
    AdminModule,
    VnpayModule,
    ReviewModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
