import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InjectConnection, MongooseModule } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

@Injectable()
class DatabaseService implements OnModuleInit {
  private readonly logger = new Logger('MongoDB');

  constructor(@InjectConnection() private readonly connection: Connection) {}

  onModuleInit(): void {
    if (this.connection.readyState === 1) {
      this.logger.log('Kết nối MongoDB thành công');
      return;
    }

    this.connection.once('connected', () => {
      this.logger.log('Kết nối MongoDB thành công');
    });

    this.connection.on('error', (error: Error) => {
      this.logger.error(`Lỗi kết nối MongoDB: ${error.message}`);
    });
  }
}

@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: configService.getOrThrow<string>('MONGODB_URI'),
      }),
    }),
  ],
  providers: [DatabaseService],
})
export class DatabaseModule {}
