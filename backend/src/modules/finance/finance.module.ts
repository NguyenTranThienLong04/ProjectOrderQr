import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PaymentIntent,
  PaymentIntentSchema,
} from '../vnpay/payment-intent.schema';
import { User, UserSchema } from '../user/user.schema';
import { CashShift, CashShiftSchema } from './cash-shift.schema';
import { CashShiftService } from './cash-shift.service';
import { RevenueService } from './revenue.service';
import {
  CashReconciliationController,
  CashShiftController,
  RevenueController,
} from './finance.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CashShift.name, schema: CashShiftSchema },
      { name: PaymentIntent.name, schema: PaymentIntentSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [
    RevenueController,
    CashShiftController,
    CashReconciliationController,
  ],
  providers: [RevenueService, CashShiftService],
})
export class FinanceModule {}
