import {
  Body,
  Controller,
  HttpCode,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { SearchMenuDto } from './menu-search.dto';
import { MenuSearchAiService } from './menu-search-ai.service';
@Controller('ai/menu')
export class MenuSearchAiController {
  constructor(private readonly searchService: MenuSearchAiService) {}
  @Post('search')
  @HttpCode(200)
  search(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: SearchMenuDto,
  ) {
    return this.searchService.search(dto);
  }
}
