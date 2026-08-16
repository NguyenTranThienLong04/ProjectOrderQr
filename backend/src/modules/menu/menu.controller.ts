import { Controller, Get, Query } from '@nestjs/common';
import { GetMenuDto } from './dto/get-menu.dto';
import { MenuService } from './menu.service';

@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get()
  getMenu(@Query() query: GetMenuDto) {
    return this.menuService.getPublicMenu(query.tableId, query.lang ?? 'vi');
  }
}
