import { Module, forwardRef } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { SessionModule } from '../modules/session/session.module';
import { SocketAuthModule } from './socket-auth.module';

@Module({
  imports: [forwardRef(() => SessionModule), SocketAuthModule],
  providers: [AppGateway],
  exports: [AppGateway],
})
export class GatewayModule {}
