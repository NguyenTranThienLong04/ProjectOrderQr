import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import { InvoiceParamsDto } from './dto/invoice.dto';
import { InvoiceLookupService } from './invoice-lookup.service';

@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class InvoiceController {
  constructor(private readonly invoices: InvoiceLookupService) {}

  @Get(':invoiceCode')
  lookup(@Param() params: InvoiceParamsDto) {
    return this.invoices.lookup(params.invoiceCode);
  }

  @Get(':invoiceCode/pdf')
  async download(@Param() params: InvoiceParamsDto, @Res() response: Response) {
    const { pdf, filename } = await this.invoices.file(
      await this.invoices.lookup(params.invoiceCode),
    );
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    response.setHeader('Content-Length', pdf.length);
    response.send(pdf);
  }
}
