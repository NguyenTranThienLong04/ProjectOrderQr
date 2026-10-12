import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { Session, SessionSchema } from '../modules/session/session.schema';
import { Table, TableSchema } from '../modules/table/table.schema';
import { SocketAuthService } from './socket-auth.service';
import { UserModule } from '../modules/user/user.module';

@Module({
  imports: [
    ConfigModule,
    UserModule,
    JwtModule.register({}),
    MongooseModule.forFeature([
      { name: Session.name, schema: SessionSchema },
      { name: Table.name, schema: TableSchema },
    ]),
  ],
  providers: [SocketAuthService],
  exports: [SocketAuthService],
})
export class SocketAuthModule {}
