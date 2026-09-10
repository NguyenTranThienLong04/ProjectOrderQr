import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '../../../common/enums/user-role.enum';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { AdminAnalyticsAiService } from './admin-analytics-ai.service';
import { AnalyticsQueryDto } from './analytics.dto';

@Controller('ai/admin/analytics/query')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminAnalyticsAiController {
  constructor(private readonly analytics: AdminAnalyticsAiService) {}
  @Post()
  @HttpCode(200)
  query(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    input: AnalyticsQueryDto,
  ) {
    return this.analytics.query(input);
  }
}
