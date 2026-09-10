import { Body, Controller, Post, ValidationPipe } from '@nestjs/common';
import { RecommendMenuDto } from './dto/recommend-menu.dto';
import { RecommendationService } from './recommendation.service';

@Controller('menu/recommendations')
export class RecommendationController {
  constructor(private readonly recommendations: RecommendationService) {}

  @Post()
  recommend(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RecommendMenuDto,
  ) {
    return this.recommendations.recommend(dto);
  }
}
