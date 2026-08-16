import {
  Controller,
  Get,
  Query,
  UseGuards,
  Patch,
  Param,
  Body,
  Post,
} from '@nestjs/common';
import { GetActiveSessionDto } from './dto/get-active-session.dto';
import { MoveSessionDto } from './dto/move-session.dto';
import { MergeSessionsDto } from './dto/merge-sessions.dto';
import { MergeTablesDto } from './dto/merge-tables.dto';
import { UnmergeSessionDto } from './dto/unmerge-session.dto';
import { SessionService } from './session.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { AppGateway } from '../../gateway/app.gateway';

/** Public because a QR table identifies a customer; no staff JWT is required for active session. */
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessionService: SessionService,
    private readonly appGateway: AppGateway,
  ) {}

  @Get('active')
  async getActive(@Query() query: GetActiveSessionDto) {
    const session = await this.sessionService.getOrCreateActiveSession(
      query.tableId,
    );
    this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    return session;
  }

  @Get('table-operation-options')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.WAITER, UserRole.ADMIN)
  getTableOperationOptions() {
    return this.sessionService.getTableOperationOptions();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.WAITER, UserRole.ADMIN)
  @Patch(':id/move-table')
  async moveTable(@Param('id') id: string, @Body() body: MoveSessionDto) {
    const result = await this.sessionService.moveSessionToTable(
      id,
      body.newTableId,
    );
    try {
      await this.appGateway.moveClientsBetweenSessions(id, result.sessionId);
      await this.appGateway.synchronizeSession(result.sessionId);
      this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    } catch {
      // gateway logs errors internally
    }
    return result;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.WAITER, UserRole.ADMIN)
  @Post('merge')
  async merge(@Body() body: MergeSessionsDto) {
    // Deprecated compatibility endpoint. It delegates to mergeTables; no second merge implementation exists.
    const result = await this.sessionService.mergeSessions(
      body.sourceSessionId,
      body.targetSessionId,
    );
    try {
      if (result.rootSessionId)
        await this.appGateway.synchronizeSession(result.rootSessionId);
      this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    } catch {
      // The DB transaction is already committed; Socket recovery occurs on reconnect.
    }
    return result;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.WAITER, UserRole.ADMIN)
  @Post('merge-tables')
  async mergeTables(@Body() body: MergeTablesDto) {
    // tableIds follows the waiter UI's natural order: keep the first table's
    // session as root and merge the second table into it.
    const targetTableId = body.tableIds?.[0] ?? body.targetTableId!;
    const sourceTableId = body.tableIds?.[1] ?? body.sourceTableId!;
    const result = await this.sessionService.mergeTables(
      sourceTableId,
      targetTableId,
    );
    await this.appGateway.emitMergeResult(result, sourceTableId, targetTableId);
    this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    return result;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.WAITER, UserRole.ADMIN)
  @Post('unmerge')
  async unmerge(@Body() body: UnmergeSessionDto) {
    const result = await this.sessionService.unmergeSession(
      body.childSessionId,
      body.tableId,
    );
    try {
      if (result.case === 'session') {
        await this.appGateway.emitUnmergeResult(result);
      } else {
        this.appGateway.emit(['waiter', 'admin'], 'table:ungrouped', result);
      }
      this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    } catch {
      // The DB transaction is already committed; Socket recovery occurs on reconnect.
    }
    return result;
  }
}
