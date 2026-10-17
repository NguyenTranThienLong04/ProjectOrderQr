import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsHash, IsInt, IsMongoId, Min } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { VnpayService } from './vnpay.service';

class CashTableParams {
  @IsMongoId()
  tableId!: string;
}

export class CashSettlementDto {
  // Confirmation preconditions only. Amount, Orders and status come from DB.
  @IsMongoId()
  sessionId!: string;

  @IsInt()
  @Min(0)
  sessionVersion!: number;

  @IsHash('sha256')
  confirmationKey!: string;
}

@Controller('payments/tables')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.WAITER)
export class CashSettlementController {
  constructor(private readonly payments: VnpayService) {}

  @Get(':tableId/cash-settlement')
  preview(@Param() params: CashTableParams) {
    return this.payments.getCashSettlementSummary(params.tableId);
  }

  @Post(':tableId/cash-settlement')
  settle(
    @Param() params: CashTableParams,
    @Body() body: CashSettlementDto,
    @Req() request: { user: { id: string; role: UserRole } },
  ) {
    return this.payments.settleCash(params.tableId, body, request.user);
  }
}
