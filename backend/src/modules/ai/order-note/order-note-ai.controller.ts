import {
  Body,
  Controller,
  HttpCode,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { AnalyzeOrderNoteDto } from './order-note.dto';
import { OrderNoteAiService } from './order-note-ai.service';
@Controller('ai/order-notes')
export class OrderNoteAiController {
  constructor(private readonly notes: OrderNoteAiService) {}
  @Post('analyze')
  @HttpCode(200)
  analyze(
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: AnalyzeOrderNoteDto,
  ) {
    return this.notes.analyze(dto);
  }
}
