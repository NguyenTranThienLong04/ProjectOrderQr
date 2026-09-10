import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Roles } from '../../../common/decorators/roles.decorator';
import { UserRole } from '../../../common/enums/user-role.enum';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../../common/guards/roles.guard';
import { ReviewFilterDto, ReviewSourcesDto } from './review-intelligence.dto';
import { ReviewIntelligenceService } from './review-intelligence.service';

@Controller('ai/admin/review-insights')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@UsePipes(
  new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  }),
)
export class ReviewIntelligenceController {
  constructor(private readonly intelligence: ReviewIntelligenceService) {}
  @Get() insights(@Query() input: ReviewFilterDto) {
    return this.intelligence.insights(input);
  }
  @Get('sources') sources(@Query() input: ReviewSourcesDto) {
    return this.intelligence.sources(input);
  }
  @Post('analyze') @HttpCode(200) analyze(@Body() input: ReviewFilterDto) {
    return this.intelligence.analyze(input);
  }
  @Post('summary') @HttpCode(200) summary(@Body() input: ReviewFilterDto) {
    return this.intelligence.summary(input);
  }
}
