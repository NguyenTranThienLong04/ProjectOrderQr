import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { CashActor, CashShiftService } from './cash-shift.service';
import {
  SubmitShiftDto,
  VerifyShiftDto,
  OpenShiftDto,
  PageQuery,
  RevenueQuery,
  ShiftParams,
  ShiftQuery,
} from './finance.dto';
import { RevenueService } from './revenue.service';

@Controller('admin/revenue')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class RevenueController {
  constructor(private readonly revenue: RevenueService) {}

  @Get()
  report(@Query() query: RevenueQuery) {
    return this.revenue.report(query);
  }

  @Get('staff')
  staff() {
    return this.revenue.staff();
  }
}

@Controller('admin/cash-shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class CashReconciliationController {
  constructor(private readonly shifts: CashShiftService) {}

  @Post(':id/verify')
  verify(
    @Param() params: ShiftParams,
    @Body() input: VerifyShiftDto,
    @Req() req: { user: CashActor },
  ) {
    return this.shifts.verify(params.id, input, req.user);
  }

  @Get()
  list(@Query() query: ShiftQuery, @Req() req: { user: CashActor }) {
    return this.shifts.list(query, req.user, false);
  }

  @Get(':id')
  detail(
    @Param() params: ShiftParams,
    @Query() query: PageQuery,
    @Req() req: { user: CashActor },
  ) {
    return this.shifts.detail(params.id, req.user, query.page);
  }
}

@Controller('cash-shifts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.WAITER)
export class CashShiftController {
  constructor(private readonly shifts: CashShiftService) {}

  @Get('current')
  current(@Req() req: { user: CashActor }) {
    return this.shifts.current(req.user);
  }

  @Get('mine')
  mine(@Query() query: PageQuery, @Req() req: { user: CashActor }) {
    return this.shifts.list(query, req.user);
  }

  @Post()
  open(@Body() input: OpenShiftDto, @Req() req: { user: CashActor }) {
    return this.shifts.open(req.user, input.openingCash);
  }

  @Get(':id')
  detail(
    @Param() params: ShiftParams,
    @Query() query: PageQuery,
    @Req() req: { user: CashActor },
  ) {
    return this.shifts.detail(params.id, req.user, query.page);
  }

  @Post(':id/submit')
  submit(
    @Param() params: ShiftParams,
    @Body() input: SubmitShiftDto,
    @Req() req: { user: CashActor },
  ) {
    return this.shifts.submit(params.id, input, req.user);
  }
}
