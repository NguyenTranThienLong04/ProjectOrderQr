import 'dotenv/config';
import * as dns from 'dns';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

// Workaround: một số mạng ISP/router chặn Node's DNS resolver (c-ares)
// dù OS resolve SRV record bình thường, gây ECONNREFUSED khi kết nối
// MongoDB Atlas qua mongodb+srv://. Chỉ áp dụng khi CUSTOM_DNS_SERVERS
// được set rõ ràng trong .env — không mặc định đổi DNS ở môi trường khác.
if (process.env.CUSTOM_DNS_SERVERS) {
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
  logger.warn(
    `Đang dùng custom DNS servers: ${process.env.CUSTOM_DNS_SERVERS}`,
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS must run before middleware that can terminate a request. This lets
  // valid preflight requests finish without consuming or being blocked by the
  // API rate limit, while actual requests still pass through every guard below.
  app.enableCors({
    origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  });

  app.use(helmet());
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 100000,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Backend đang chạy tại http://localhost:${port}`);
}
bootstrap();
