import { Injectable, OnModuleInit } from '@nestjs/common';
import { MenuService } from '../../menu/menu.service';
import {
  ingredientMatches,
  normalizeSearchText,
  searchWarnings,
  type MenuSearchFilters,
} from '../../menu/menu-search';
import { AiOrchestratorService } from '../ai-orchestrator.service';
import { AiError } from '../ai.errors';
import { AiPromptRegistry } from '../prompts/ai-prompt-registry.service';
import { MENU_SEARCH_PROMPT } from '../prompts/menu-search.prompt';
import { MENU_SEARCH_OUTPUT, SearchMenuDto } from './menu-search.dto';

@Injectable()
export class MenuSearchAiService implements OnModuleInit {
  constructor(
    private readonly menu: MenuService,
    private readonly orchestrator: AiOrchestratorService,
    private readonly prompts: AiPromptRegistry,
  ) {}
  onModuleInit() {
    this.prompts.register(MENU_SEARCH_PROMPT);
  }
  async search(dto: SearchMenuDto) {
    const lang = dto.lang ?? 'vi';
    // Reuse public menu's table boundary before any provider call. No session creation.
    const catalog = await this.menu.getSearchCatalog(dto.tableId);
    const messages = searchWarnings(lang);
    let response;
    try {
      response = await this.orchestrator.generateStructured({
        feature: MENU_SEARCH_PROMPT.feature,
        promptVersion: MENU_SEARCH_PROMPT.promptVersion,
        input: JSON.stringify({
          query: dto.query,
          lang,
          categories: catalog.categories
            .slice(0, 80)
            .map(({ name, nameEn }) => ({
              name: name.slice(0, 80),
              nameEn: nameEn?.slice(0, 80),
            })),
        }),
        output: MENU_SEARCH_OUTPUT,
        fallbackOnError: true,
      });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      const found = await this.menu.searchPublicMenu(
        dto.tableId,
        {},
        dto.query,
        lang,
        true,
      );
      return {
        ...found,
        warnings: [messages.fallback],
        modelVersion: 'text-search:menu-search-v1',
        fallbackUsed: true,
      };
    }
    const { unsupportedCriteria, ...parsed } = response.result;
    let filters: MenuSearchFilters = Object.fromEntries(
      Object.entries(parsed).filter(
        ([, value]) =>
          value !== null && (!Array.isArray(value) || value.length),
      ),
    );
    // Fixed warning even when a model misses common unsupported health requests.
    // This is a veto, not a medical classification or a second semantic parser.
    const healthRequest =
      /\b(tieu duong|diabetes|diabetic|tot cho tim|benh tim|tim mach|heart|cholesterol|protein|dinh duong|nutrition|calorie|calo|huyet ap|blood pressure)\b/.test(
        normalizeSearchText(dto.query),
      );
    const warnings = [...(response.warnings ?? [])];
    if (unsupportedCriteria.length || healthRequest)
      warnings.push(messages.unsupported);
    // No nutrition/medical source exists. Refuse even plausible model substitutions.
    // Mixed health requests can be retried using only the supported conditions.
    if (
      healthRequest ||
      unsupportedCriteria.some(
        (criterion) => criterion === 'medical' || criterion === 'nutrition',
      )
    )
      filters = {};
    // A language-level peanut/egg/milk exclusion also excludes its recorded allergen
    // even if the model omitted the corresponding tag. This infers no recipe facts.
    const linkedAllergens = ['peanut', 'egg', 'milk'].filter((tag) =>
      filters.excludedIngredients?.some((term) => ingredientMatches(term, tag)),
    );
    if (linkedAllergens.length)
      filters.excludedAllergens = [
        ...new Set([...(filters.excludedAllergens ?? []), ...linkedAllergens]),
      ];
    // Unsupported-only/empty parsing must not present the entire menu as a match.
    const empty = Object.keys(filters).length === 0;
    const found = await this.menu.searchPublicMenu(
      dto.tableId,
      filters,
      dto.query,
      lang,
      empty,
    );
    return {
      ...response,
      ...found,
      warnings: [
        ...warnings,
        ...found.warnings,
        ...(empty ? [messages.fallback] : []),
      ],
      fallbackUsed: empty,
    };
  }
}
