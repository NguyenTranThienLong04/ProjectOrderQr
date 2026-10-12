import { IsMongoId, IsOptional } from 'class-validator';

export class GetActiveSessionDto {
  @IsMongoId()
  tableId!: string;

  // Reconnect can renew this existing session, but must never open another one.
  @IsOptional()
  @IsMongoId()
  sessionId?: string;
}
