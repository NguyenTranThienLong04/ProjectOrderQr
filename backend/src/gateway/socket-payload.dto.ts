import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  validateSync,
} from 'class-validator';
import { WsException } from '@nestjs/websockets';

export class JoinRoomPayload {
  @IsString() @MaxLength(100) room!: string;
}
export class JoinCartPayload {
  @IsMongoId() sessionId!: string;
}
export class RemoveCartPayload extends JoinCartPayload {
  @IsMongoId() dishId!: string;
  @IsOptional() @IsMongoId() cartItemId?: string;
}
export class AddCartPayload extends JoinCartPayload {
  @IsMongoId() dishId!: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) quantity?: number;
  @IsOptional() @IsString() @MaxLength(250) note?: string;
  @IsOptional() @IsString() @MaxLength(8192) analysisToken?: string;
  @IsOptional() @IsBoolean() confirmedByCustomer?: boolean;
}
export class UpdateQuantityPayload extends RemoveCartPayload {
  @IsInt() @Min(1) @Max(50) quantity!: number;
}
export class CallWaiterPayload {
  @IsMongoId() tableId!: string;
}

export function socketPayload<T extends object>(
  type: new () => T,
  value: unknown,
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WsException('Payload Socket không hợp lệ');
  const dto = plainToInstance(type, value);
  if (validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length)
    throw new WsException('Payload Socket không hợp lệ');
  return dto;
}
