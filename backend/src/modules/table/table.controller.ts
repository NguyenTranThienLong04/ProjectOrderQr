import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Patch,
} from '@nestjs/common';
import { TableService } from './table.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AppGateway } from '../../gateway/app.gateway';

@Controller('tables')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TableController {
  constructor(
    private readonly tableService: TableService,
    private readonly appGateway: AppGateway,
  ) {}

  @Get()
  @Roles(UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN)
  async findAll() {
    return this.tableService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.WAITER, UserRole.KITCHEN)
  async findOne(@Param('id') id: string) {
    return this.tableService.findOne(id);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  async create(@Body() createTableDto: CreateTableDto) {
    return this.tableService.create(createTableDto);
  }

  @Put(':id')
  @Roles(UserRole.ADMIN)
  async update(
    @Param('id') id: string,
    @Body() updateTableDto: UpdateTableDto,
  ) {
    return this.tableService.update(id, updateTableDto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string) {
    await this.tableService.remove(id);
    return { success: true, message: 'Xóa bàn thành công' };
  }

  @Post(':id/regenerate-qr')
  @Roles(UserRole.ADMIN)
  async regenerateQr(@Param('id') id: string) {
    return this.tableService.regenerateQr(id);
  }

  @Patch(':id/clear')
  @Roles(UserRole.ADMIN, UserRole.WAITER)
  async clear(@Param('id') id: string) {
    const table = await this.tableService.clear(id);
    this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    return table;
  }
}
