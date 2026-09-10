import { Injectable, OnModuleInit } from '@nestjs/common';
import { AiOrchestratorService } from '../ai-orchestrator.service';
import { AiError } from '../ai.errors';
import { AiPromptRegistry } from '../prompts/ai-prompt-registry.service';
import {
  ANALYTICS_ANSWER_PROMPT,
  ANALYTICS_INTENT_PROMPT,
} from '../prompts/admin-analytics.prompt';
import {
  analyticsAnswerOutput,
  analyticsIntentOutput,
  AnalyticsQueryDto,
} from './analytics.dto';
import { resolveIntent, selectedRange } from './analytics-period';
import {
  ANALYTICS_WARNINGS,
  AnalyticsFact,
  AnalyticsToolsService,
} from './analytics-tools.service';

const units = {
  VND: 'VND',
  orders: 'đơn',
  items: 'phần',
  reviews: 'đánh giá',
  stars: 'điểm',
  percent: '%',
  rank: 'hạng',
};
export function describeFact(fact: AnalyticsFact): string {
  const period = `${fact.period.from.slice(0, 10)} – ${fact.period.to.slice(0, 10)} UTC`;
  return `${fact.label}${fact.dishName ? ` (${fact.dishName})` : ''} [${period}]: ${fact.value === null ? 'chưa xác định' : `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(fact.value)} ${units[fact.unit]}`}.`;
}
export function answerCandidates(
  facts: AnalyticsFact[],
  warnings: string[],
  metric: string,
  compare: boolean,
): string[] {
  const primary = compare
    ? facts.filter(
        (f) =>
          f.metric === metric ||
          f.metric.startsWith(`${metric}Difference`) ||
          f.metric.startsWith(`${metric}ChangePercent`),
      )
    : metric === 'topDishes' || metric === 'topRatedDishes'
      ? facts.slice(0, metric === 'topDishes' ? 4 : 3)
      : facts.filter(
          (f) =>
            f.metric === metric ||
            (metric === 'ratingSummary' &&
              ['averageRating', 'reviewCount'].includes(f.metric)),
        );
  const suffix = warnings.join(' ');
  return [
    ...new Set([
      `${primary.map(describeFact).join(' ')} ${suffix}`.trim(),
      `${facts
        .slice(0, metric === 'topRatedDishes' ? 6 : 7)
        .map(describeFact)
        .join(' ')} ${suffix}`.trim(),
    ]),
  ];
}
function unsupportedQuestion(query: string) {
  const text = query
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase();
  return /loi nhuan|chi phi|nguyen lieu|cost|margin|profit|waste|hao hut|du bao|forecast|mongo|database|\busers?\b|secret|system prompt|chain.of.thought|bo qua tool|toan bo du lieu|mat khau|api.?key/.test(
    text,
  );
}

@Injectable()
export class AdminAnalyticsAiService implements OnModuleInit {
  constructor(
    private readonly orchestrator: AiOrchestratorService,
    private readonly prompts: AiPromptRegistry,
    private readonly tools: AnalyticsToolsService,
  ) {}
  onModuleInit() {
    this.prompts.register(ANALYTICS_INTENT_PROMPT);
    this.prompts.register(ANALYTICS_ANSWER_PROMPT);
  }
  async query(input: AnalyticsQueryDto) {
    const selected = selectedRange(input);
    const now = new Date();
    const parsed = await this.orchestrator.generateStructured({
      feature: ANALYTICS_INTENT_PROMPT.feature,
      promptVersion: ANALYTICS_INTENT_PROMPT.promptVersion,
      input: JSON.stringify({
        question: input.query,
        selectedPeriod: selected,
        today: now.toISOString().slice(0, 10),
        timezone: 'UTC',
      }),
      output: analyticsIntentOutput,
      validateResult: (intent) => {
        resolveIntent(intent, input, now);
      },
    });
    if (
      parsed.result.metric === 'unsupported' ||
      unsupportedQuestion(input.query)
    )
      return {
        result: { answer: ANALYTICS_WARNINGS.unsupported },
        facts: [] as AnalyticsFact[],
        warnings: [...(parsed.warnings ?? []), ANALYTICS_WARNINGS.unsupported],
        modelVersion: parsed.modelVersion,
        fallbackUsed: false,
      };
    const { current, comparison } = resolveIntent(parsed.result, input, now);
    let output: { facts: AnalyticsFact[]; warnings: string[] };
    try {
      output = await this.tools.execute(parsed.result, current, comparison);
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError('AI_ANALYTICS_UNAVAILABLE');
    }
    const warnings = [
      ...(parsed.warnings ?? []),
      ...output.warnings,
      ANALYTICS_WARNINGS.causes,
    ];
    if (
      current.to > now.toISOString() ||
      (parsed.result.operation === 'compare' &&
        comparison.to > now.toISOString())
    )
      warnings.push(ANALYTICS_WARNINGS.partial);
    const candidates = answerCandidates(
      output.facts,
      warnings,
      parsed.result.metric,
      parsed.result.operation === 'compare',
    );
    const response = await this.orchestrator.generateStructured({
      feature: ANALYTICS_ANSWER_PROMPT.feature,
      promptVersion: ANALYTICS_ANSWER_PROMPT.promptVersion,
      input: JSON.stringify({
        question: input.query,
        facts: output.facts,
        warnings,
      }),
      output: analyticsAnswerOutput(candidates),
    });
    return {
      ...response,
      facts: output.facts,
      warnings: [...new Set([...warnings, ...(response.warnings ?? [])])],
    };
  }
}
