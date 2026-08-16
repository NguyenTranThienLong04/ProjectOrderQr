import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { CreateReviewDto } from './dto/create-review.dto';
import { GetReviewableOrderDto } from './dto/get-reviewable-order.dto';
import { ReviewService } from './review.service';

@Controller('reviews')
export class ReviewController {
  constructor(private readonly reviewService: ReviewService) {}
  @Post() create(@Body() dto: CreateReviewDto) {
    return this.reviewService.create(dto);
  }
  @Get('reviewable') getReviewable(@Query() dto: GetReviewableOrderDto) {
    return this.reviewService.getReviewableOrder(dto.orderId, dto.sessionId);
  }
}
