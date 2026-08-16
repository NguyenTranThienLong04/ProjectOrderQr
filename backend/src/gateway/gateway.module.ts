import { Module, forwardRef } from '@nestjs/common';
import { AppGateway } from './app.gateway';
import { SessionModule } from '../modules/session/session.module';

@Module({
  imports: [forwardRef(() => SessionModule)],
  providers: [AppGateway],
  exports: [AppGateway],
})
export class GatewayModule {}
