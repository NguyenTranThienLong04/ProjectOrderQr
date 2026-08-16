import { IsMongoId } from 'class-validator';

export class GetInvoiceDto {
  @IsMongoId()
  sessionId!: string;
}

export class GetInvoiceParamsDto {
  @IsMongoId()
  orderId!: string;
}
