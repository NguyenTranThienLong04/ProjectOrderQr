import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  Get,
} from '@nestjs/common';
import type { Response } from 'express';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderService } from './order.service';
import { AppGateway } from '../../gateway/app.gateway';
import { OrderStateMachineService } from './order-state-machine.service';
import { TransitionOrderItemDto } from './dto/transition-order-item.dto';
import { GetInvoiceDto, GetInvoiceParamsDto } from './dto/get-invoice.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { InvoiceLookupService } from '../invoice/invoice-lookup.service';

/** Customer endpoint: deliberately public; DTO and service validate all references. */
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly appGateway: AppGateway,
    private readonly stateMachine: OrderStateMachineService,
    private readonly invoices: InvoiceLookupService,
  ) {}

  @Post()
  async create(@Body() createOrderDto: CreateOrderDto) {
    const result = await this.orderService.createCustomerOrder(createOrderDto);
    await this.appGateway.synchronizeSession(result.sessionId);
    // Ownership follows the merged Session while tableId remains the physical
    // source-table audit reference. Every customer in that Session gets the event.
    await this.appGateway.emitOrderUpdated(result);
    this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    return result;
  }

  @Get('kitchen')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KITCHEN, UserRole.ADMIN)
  async listForKitchen() {
    return this.orderService.listForKitchen();
  }

  @Get('waiter')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.WAITER, UserRole.ADMIN)
  async listForWaiter() {
    return this.orderService.listForWaiter();
  }

  @Get('waiter/payment-summaries')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.WAITER, UserRole.ADMIN)
  async listPaymentSummariesForWaiter() {
    return this.orderService.listPaymentSummariesForWaiter();
  }

  @Get(':orderId/payment-status')
  async paymentStatus(
    @Param('orderId') orderId: string,
    @Query() dto: GetInvoiceDto,
  ) {
    return this.orderService.getPaymentStatus(orderId, dto.sessionId);
  }

  @Get(':orderId/invoice')
  async invoice(
    @Param() params: GetInvoiceParamsDto,
    @Query() dto: GetInvoiceDto,
    @Res() response: Response,
  ) {
    const { pdf, filename } = await this.invoices.legacyFile(
      params.orderId,
      dto.sessionId,
    );
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    response.setHeader('Content-Length', pdf.length);
    response.send(pdf);
  }

  @Patch(':orderId/items/:itemId/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.KITCHEN, UserRole.WAITER, UserRole.ADMIN)
  async transition(
    @Param('orderId') orderId: string,
    @Param('itemId') itemId: string,
    @Body() body: TransitionOrderItemDto,
    @Req() req: { user: { id: string; role: UserRole } },
  ) {
    const order = await this.stateMachine.transitionItem(
      orderId,
      itemId,
      body.status,
      req.user,
    );
    await this.appGateway.emitOrderUpdated(order);
    this.appGateway.emit(['waiter', 'admin'], 'tables:updated');
    return order;
  }

  // Customer cancel (public via sessionId) — only allowed when order.status === Pending (validated in service)
  @Patch(':orderId/cancel')
  async cancel(
    @Param('orderId') orderId: string,
    @Query('sessionId') sessionId: string,
  ) {
    const order = await this.stateMachine.cancelCustomer(orderId, sessionId);
    await this.appGateway.emitOrderUpdated(order);
    return order;
  }

  // Admin override cancel (can cancel at any state)
  @Patch(':orderId/cancel/admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async adminCancel(
    @Param('orderId') orderId: string,
    @Req() req: { user: { id: string; role: UserRole } },
  ) {
    const order = await this.stateMachine.cancelByAdmin(orderId, req.user);
    await this.appGateway.emitOrderUpdated(order);
    return order;
  }
}
