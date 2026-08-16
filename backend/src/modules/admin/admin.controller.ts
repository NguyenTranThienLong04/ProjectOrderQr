import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { RevenueQueryDto, TopDishesQueryDto } from './dto/analytics-query.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

@Controller('admin/analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('revenue')
  @Roles(UserRole.ADMIN)
  async getRevenue(@Query() q: RevenueQueryDto) {
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    const groupBy = (q.groupBy as any) || 'day';
    const data = await this.adminService.getRevenue(from, to, groupBy);
    return data;
  }

  @Get('top-dishes')
  @Roles(UserRole.ADMIN)
  async getTopDishes(@Query() q: TopDishesQueryDto) {
    const from = q.from ? new Date(q.from) : undefined;
    const to = q.to ? new Date(q.to) : undefined;
    const limit = q.limit ? parseInt(q.limit, 10) : 10;
    const data = await this.adminService.getTopDishes(from, to, limit);
    return data;
  }

  @Get('top-rated-dishes')
  @Roles(UserRole.ADMIN)
  async getTopRatedDishes(@Query('limit') limit?: string) {
    const parsed = limit ? Number(limit) : 10;
    return this.adminService.getTopRatedDishes(
      Number.isInteger(parsed) && parsed > 0 && parsed <= 50 ? parsed : 10,
    );
  }

  @Get('overview')
  @Roles(UserRole.ADMIN)
  async getOverview() {
    return this.adminService.getOverview();
  }
}
