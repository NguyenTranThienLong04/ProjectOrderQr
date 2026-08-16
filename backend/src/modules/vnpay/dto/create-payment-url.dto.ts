import { IsMongoId, IsString, Length, Matches } from 'class-validator';

export class CreatePaymentUrlDto {
  @IsMongoId({ message: 'sessionId không hợp lệ' })
  sessionId!: string;

  @IsMongoId({ message: 'tableId không hợp lệ' })
  tableId!: string;
}

export class PaymentStatusDto extends CreatePaymentUrlDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9]+$/, { message: 'txnRef không hợp lệ' })
  txnRef!: string;
}
