import {
  Body,
  Controller,
  Get,
  Ip,
  Post,
  Query,
  Redirect,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreatePaymentUrlDto,
  PaymentStatusDto,
} from './dto/create-payment-url.dto';
import { VnpayService } from './vnpay.service';
import { frontendUrl } from '../../common/config/public-urls';

@Controller('vnpay')
export class VnpayController {
  constructor(private readonly vnpayService: VnpayService) {}

  @Post('create-payment-url')
  async createPaymentUrl(@Body() body: CreatePaymentUrlDto, @Ip() ip: string) {
    return this.vnpayService.createPaymentUrl(body.sessionId, body.tableId, ip);
  }

  @Get('session-summary')
  async sessionSummary(@Query() query: CreatePaymentUrlDto) {
    return this.vnpayService.getSessionPaymentSummary(
      query.sessionId,
      query.tableId,
    );
  }

  @Get('payment-status')
  async paymentStatus(@Query() query: PaymentStatusDto) {
    return this.vnpayService.getPaymentStatus(
      query.txnRef,
      query.sessionId,
      query.tableId,
    );
  }

  @Get('session-invoice')
  async sessionInvoice(
    @Query() query: PaymentStatusDto,
    @Res() response: Response,
  ) {
    const { pdf, filename } =
      await this.vnpayService.generateSessionInvoiceFile(
        query.txnRef,
        query.sessionId,
        query.tableId,
      );
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    response.setHeader('Content-Length', pdf.length);
    response.send(pdf);
  }

  /** Browser callback only. It never mutates Order.status; IPN is authoritative. */
  @Get('return')
  @Redirect()
  async paymentReturn(@Query() query: Record<string, string | undefined>) {
    const valid = this.vnpayService.verifySignature(query, 'return');
    const result =
      valid && query.vnp_ResponseCode === '00' ? 'pending' : 'failed';
    const context = valid ? await this.vnpayService.handleReturn(query) : null;
    const txnRef = context?.txnRef ?? query.vnp_TxnRef ?? '';
    const params = new URLSearchParams({ result, txnRef });
    if (context?.tableId) params.set('tableId', context.tableId);
    if (context?.sessionId) params.set('sessionId', context.sessionId);
    if (query.vnp_ResponseCode)
      params.set('responseCode', query.vnp_ResponseCode);
    return {
      url: `${frontendUrl()}/payment-result?${params.toString()}`,
    };
  }

  @Get('ipn')
  async ipn(@Query() query: Record<string, string | undefined>) {
    return this.vnpayService.handleIpn(query);
  }
}
