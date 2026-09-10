import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Model } from 'mongoose';
import { Category } from '../../category/category.schema';
import { AiOrchestratorService } from '../ai-orchestrator.service';
import { AiError } from '../ai.errors';
import type { AiResponse } from '../ai.types';
import { AiPromptRegistry } from '../prompts/ai-prompt-registry.service';
import { DISH_DRAFT_PROMPT } from '../prompts/dish-draft.prompt';
import { DishDraftDto, type DishDraftResult } from './dish-draft.dto';
import { dishDraftOutput } from './dish-draft-output';

@Injectable()
export class CatalogDraftAiService implements OnModuleInit {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly prompts: AiPromptRegistry,
    @InjectModel(Category.name) private readonly categories: Model<Category>,
  ) {}

  onModuleInit() {
    this.prompts.register(DISH_DRAFT_PROMPT);
  }

  async generate(
    input: DishDraftDto,
  ): Promise<AiResponse<DishDraftResult> & { warnings: string[] }> {
    const dto = plainToInstance(DishDraftDto, input);
    if (
      (
        await validate(dto, {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        })
      ).length
    )
      throw new AiError('AI_INVALID_REQUEST');
    let category: { name: string; nameEn?: string } | undefined;
    if (dto.categoryId) {
      const record = await this.categories
        .findById(dto.categoryId)
        .select('name nameEn -_id')
        .lean()
        .exec();
      if (!record)
        throw new NotFoundException('Không tìm thấy danh mục món ăn.');
      // Explicit projection/allowlist: no unrelated records or factual metadata.
      category = {
        name: record.name.slice(0, 200),
        nameEn: record.nameEn?.slice(0, 200),
      };
    }
    const response = await this.orchestrator.generateStructured({
      feature: DISH_DRAFT_PROMPT.feature,
      promptVersion: DISH_DRAFT_PROMPT.promptVersion,
      input: JSON.stringify({
        draftText: {
          name: dto.name,
          nameEn: dto.nameEn,
          description: dto.description,
          descriptionEn: dto.descriptionEn,
        },
        generateFields: dto.generateFields,
        backendContext: { category },
      }),
      output: dishDraftOutput(dto.generateFields),
    });
    return { ...response, warnings: response.warnings ?? [] };
  }
}
