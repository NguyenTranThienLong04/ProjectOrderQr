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
import { CatalogDraftAiService } from './catalog-draft-ai.service';
import { DishDraftDto } from './dish-draft.dto';

@Controller('ai/admin/dish-draft')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class CatalogDraftAiController {
  constructor(private readonly drafts: CatalogDraftAiService) {}

  @Post()
  @HttpCode(200)
  generate(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: DishDraftDto,
  ) {
    return this.drafts.generate(dto);
  }
}
