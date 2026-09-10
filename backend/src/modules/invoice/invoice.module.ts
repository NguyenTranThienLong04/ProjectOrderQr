import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InvoiceService } from '../order/invoice.service';
import { Order, OrderSchema } from '../order/order.schema';
import { Session, SessionSchema } from '../session/session.schema';
import { Table, TableSchema } from '../table/table.schema';
import {
  PaymentIntent,
  PaymentIntentSchema,
} from '../vnpay/payment-intent.schema';
import { InvoiceController } from './invoice.controller';
import { InvoiceLookupService } from './invoice-lookup.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentIntent.name, schema: PaymentIntentSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Session.name, schema: SessionSchema },
      { name: Table.name, schema: TableSchema },
    ]),
  ],
  controllers: [InvoiceController],
  providers: [InvoiceLookupService, InvoiceService],
  exports: [InvoiceLookupService, InvoiceService],
})
export class InvoiceModule {}
