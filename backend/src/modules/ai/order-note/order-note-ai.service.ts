import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { SessionStatus } from '../../../common/enums/session-status.enum';
import { issueOrderNoteReceipt } from '../../../common/order-note-receipt';
import { Dish } from '../../dish/dish.schema';
import { DISH_METADATA_OPTIONS } from '../../dish/dish-metadata';
import { Session } from '../../session/session.schema';
import { Table } from '../../table/table.schema';
import { AiOrchestratorService } from '../ai-orchestrator.service';
import { AiPromptRegistry } from '../prompts/ai-prompt-registry.service';
import { ORDER_NOTE_PROMPT } from '../prompts/order-note.prompt';
import { AnalyzeOrderNoteDto, ORDER_NOTE_OUTPUT } from './order-note.dto';
import { safeOrderNoteResult } from './order-note-safety';

@Injectable()
export class OrderNoteAiService implements OnModuleInit {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly prompts: AiPromptRegistry,
    @InjectModel(Session.name) private readonly sessions: Model<Session>,
    @InjectModel(Table.name) private readonly tables: Model<Table>,
    @InjectModel(Dish.name) private readonly dishes: Model<Dish>,
  ) {}
  onModuleInit() {
    this.prompts.register(ORDER_NOTE_PROMPT);
  }
  async analyze(dto: AnalyzeOrderNoteDto) {
    const session = await this.sessions
      .findOne({ _id: dto.sessionId, status: SessionStatus.ACTIVE })
      .exec();
    const table = await this.tables.findById(dto.tableId).exec();
    if (
      !session ||
      !table ||
      table.currentSessionId?.toString() !== dto.sessionId ||
      !(session.tableIds?.length ? session.tableIds : [session.tableId]).some(
        (id) => id.toString() === dto.tableId,
      )
    ) {
      throw new ForbiddenException('Phiên ăn hoặc bàn không hợp lệ.');
    }
    const dish = await this.dishes
      .findOne({ _id: dto.dishId, isAvailable: true })
      .exec();
    if (!dish)
      throw new NotFoundException('Món không tồn tại hoặc đã hết món.');
    const response = await this.orchestrator.generateStructured({
      feature: ORDER_NOTE_PROMPT.feature,
      promptVersion: ORDER_NOTE_PROMPT.promptVersion,
      input: JSON.stringify({
        note: dto.note,
        taxonomy: DISH_METADATA_OPTIONS.modifiers,
        availableModifiers: dish.availableModifiers ?? [],
      }),
      output: ORDER_NOTE_OUTPUT,
    });
    const safe = safeOrderNoteResult(
      dto.note,
      response.result,
      dish.availableModifiers ?? [],
      dish.allergenTags,
    );
    const warnings = [...safe.warnings, ...(response.warnings ?? [])];
    const analysisToken = issueOrderNoteReceipt(
      dto.sessionId,
      dto.dishId,
      dto.note,
      {
        ...safe.result,
        warnings,
        confirmedByCustomer: true,
        modelVersion: response.modelVersion,
        fallbackUsed: response.fallbackUsed,
      },
    );
    return { ...response, ...safe, warnings, analysisToken };
  }
}
