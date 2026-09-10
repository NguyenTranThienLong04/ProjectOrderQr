import assert from 'node:assert/strict';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import {
  AiAuditEntry,
  AiAuditService,
} from '../../src/modules/ai/ai-audit.service';
import { AiConfig } from '../../src/modules/ai/ai.config';
import { AiOrchestratorService } from '../../src/modules/ai/ai-orchestrator.service';
import { AiPromptRegistry } from '../../src/modules/ai/prompts/ai-prompt-registry.service';
import {
  AiProvider,
  AiProviderRequest,
} from '../../src/modules/ai/providers/ai-provider.interface';
import { CatalogDraftAiService } from '../../src/modules/ai/catalog-draft/catalog-draft-ai.service';
import { OrderNoteAiService } from '../../src/modules/ai/order-note/order-note-ai.service';
import { MenuSearchAiService } from '../../src/modules/ai/menu-search/menu-search-ai.service';
import { AdminAnalyticsAiService } from '../../src/modules/ai/admin-analytics/admin-analytics-ai.service';
import {
  AnalyticsToolsService,
  ANALYTICS_WARNINGS,
} from '../../src/modules/ai/admin-analytics/analytics-tools.service';
import { ReviewIntelligenceService } from '../../src/modules/ai/review-intelligence/review-intelligence.service';
import { AdminService } from '../../src/modules/admin/admin.service';
import {
  Category,
  CategoryDocument,
} from '../../src/modules/category/category.schema';
import { Dish, DishDocument } from '../../src/modules/dish/dish.schema';
import { Session } from '../../src/modules/session/session.schema';
import { Table, TableDocument } from '../../src/modules/table/table.schema';
import { ReviewDocument } from '../../src/modules/review/review.schema';
import { MenuService } from '../../src/modules/menu/menu.service';
import { DISH_MODIFIERS } from '../../src/modules/dish/dish-metadata';
import {
  analyticsCases,
  dishDraftCases,
  noteCases,
  reviewCases,
  searchCases,
} from './dataset.v1';

export function candidate(request: AiProviderRequest) {
  const schema = request.jsonSchema.properties as {
    answer: { enum: string[] };
  };
  return { output: { answer: schema.answer.enum[0] } };
}
const query = <T>(value: T) => ({
  exec: () => Promise.resolve(value),
  lean: () => query(value),
  select: () => query(value),
  sort: () => query(value),
  limit: () => query(value),
  option: () => query(value),
});

/** Real feature/orchestrator/filter/tool code, synthetic repository doubles; no database writes. */
export function evaluationHarness(provider: AiProvider, config: AiConfig) {
  const audits: AiAuditEntry[] = [];
  const audit = {
    record: (entry: AiAuditEntry) => {
      audits.push(entry);
      return Promise.resolve(true);
    },
  } as AiAuditService;
  const prompts = new AiPromptRegistry();
  const outputs = new Map<string, unknown>();
  const observed: AiProvider = {
    generateStructured: async (request) => {
      const response = await provider.generateStructured(request);
      outputs.set(request.schemaName, response.output);
      return response;
    },
  };
  const ai = new AiOrchestratorService(config, observed, prompts, audit);
  const tableId = new Types.ObjectId(),
    sessionId = new Types.ObjectId(),
    categoryId = new Types.ObjectId();
  const catalog = [
    { name: 'Phở bò tái', price: 80000, ingredients: ['bò'], spiceLevel: 0 },
    {
      name: 'Đậu hũ',
      price: 40000,
      ingredients: ['đậu hũ'],
      dietaryTags: ['vegetarian'],
      spiceLevel: 0,
    },
    { name: 'Món thiếu metadata', price: 30000 },
    {
      name: 'Bò đậu phộng',
      price: 90000,
      ingredients: ['bò', 'đậu phộng'],
      allergenTags: ['peanut'],
      spiceLevel: 1,
    },
    {
      name: 'Bún bò Huế',
      price: 120000,
      ingredients: ['bò', 'đậu phộng'],
      allergenTags: ['peanut'],
      spiceLevel: 2,
    },
  ].map((d) => ({
    _id: new Types.ObjectId(),
    categoryId,
    isAvailable: true,
    availableModifiers: [...DISH_MODIFIERS],
    ...d,
  }));
  const tables = {
    findById: () => query({ _id: tableId, currentSessionId: sessionId }),
  };
  const sessions = {
    findOne: () =>
      query({ _id: sessionId, tableId, tableIds: [tableId], cart: [] }),
  };
  const dishes = {
    find: () => query(catalog),
    findOne: () => query(catalog[0]),
  };
  const categories = {
    find: () => query([{ _id: categoryId, name: 'Món ăn' }]),
  };
  const menu = new MenuService(
    tables as unknown as Model<TableDocument>,
    categories as unknown as Model<CategoryDocument>,
    dishes as unknown as Model<DishDocument>,
  );
  const draft = new CatalogDraftAiService(
    ai,
    prompts,
    categories as unknown as Model<Category>,
  );
  const note = new OrderNoteAiService(
    ai,
    prompts,
    sessions as unknown as Model<Session>,
    tables as unknown as Model<Table>,
    dishes as unknown as Model<Dish>,
  );
  const search = new MenuSearchAiService(menu, ai, prompts);
  const admin = {
    getRevenue: (from: Date) =>
      Promise.resolve([
        {
          revenue:
            from.getUTCMonth() === new Date().getUTCMonth() ? 300000 : 400000,
          orders: 2,
        },
      ]),
    getTopDishes: () =>
      Promise.resolve([
        { dishName: 'Phở bò tái', totalQuantity: 3, revenue: 240000 },
      ]),
    getRatingSummary: () =>
      Promise.resolve([{ reviewCount: 2, averageRating: 4 }]),
  } as unknown as AdminService;
  const analytics = new AdminAnalyticsAiService(
    ai,
    prompts,
    new AnalyticsToolsService(admin),
  );
  let comment = '';
  let saved: Record<string, unknown> | undefined;
  const reviews = {
    find: () => query([{ _id: new Types.ObjectId(), comment }]),
    updateOne: (
      _filter: unknown,
      update: { $set: { aiInsight: Record<string, unknown> } },
    ) => {
      saved = update.$set.aiInsight;
      return query({ modifiedCount: 1 });
    },
    aggregate: () =>
      query([
        {
          totals: [{ totalReviews: 3, commentCount: 2, averageRating: 4 }],
          sentiments: [{ _id: 'positive', count: 1 }],
          topics: [
            { _id: { topic: 'taste', sentiment: 'positive' }, count: 1 },
          ],
        },
      ]),
  };
  const review = new ReviewIntelligenceService(
    reviews as unknown as Model<ReviewDocument>,
    ai,
    prompts,
  );
  [draft, note, search, analytics, review].forEach((s) => s.onModuleInit());
  return {
    audits,
    outputs,
    catalog,
    tableId: tableId.toString(),
    sessionId: sessionId.toString(),
    draft,
    note,
    search,
    analytics,
    review,
    setComment: (text: string) => {
      comment = text;
      saved = undefined;
    },
    insight: () => saved,
  };
}

export interface EvaluationCase {
  id: string;
  feature: string;
  output: unknown;
  expected: unknown;
  run: (h: ReturnType<typeof evaluationHarness>) => Promise<void>;
}
export const evaluationCases: EvaluationCase[] = [
  ...dishDraftCases.map((c) => ({
    id: c.id,
    feature: 'Dish Draft',
    output: { nameEn: c.nameEn, descriptionEn: c.descriptionEn },
    expected: {
      requiredFields: ['nameEn', 'descriptionEn'],
      sourceIdentity: c.name,
      referenceTranslation: c.nameEn,
      checks:
        'Faithful source identity; no unsupported factual claims. Reference wording is not exact-match.',
    },
    run: async (h: ReturnType<typeof evaluationHarness>) => {
      const response = await h.draft.generate({
        name: c.name,
        description: c.description,
        generateFields: ['nameEn', 'descriptionEn'],
      });
      assert.equal(response.fallbackUsed, false);
      assert.deepEqual(Object.keys(response.result).sort(), [
        'descriptionEn',
        'nameEn',
      ]);
      // Conservative automated screen; naturalness/factual prose still requires human review.
      const copy = Object.values(response.result)
        .join(' ')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
      const identity = c.name
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
      const nameCopy = response.result
        .nameEn!.normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toLowerCase();
      // Pho/bo/tai may be faithfully translated as pho/beef/rare. Require all
      // three concepts in the name, not one exact Vietnamese wording in prose.
      const faithfulPho =
        c.id === 'dish-pho' &&
        ['pho', 'beef', 'rare'].every((word) =>
          new RegExp(`\\b${word}\\b`).test(nameCopy),
        );
      assert.ok(
        c.id === 'dish-pho'
          ? nameCopy.includes(identity) || faithfulPho
          : copy.includes(identity),
        'culinary identity missing',
      );
      assert.ok(
        !/peanut|shellfish|allergen.free|gluten.free|healthy|calories|pork|shrimp|coconut|turmeric|fish sauce/.test(
          copy,
        ),
        'unsupported factual claim screen',
      );
    },
  })),
  ...noteCases.map((c) => ({
    id: c.id,
    feature: 'Order Note',
    expected: {
      modifierTags: c.tags,
      allergyMentioned: c.allergy,
      needsStaffReview: c.review,
      forChildren: c.forChildren ?? false,
    },
    output: {
      modifierTags: [...c.tags],
      allergyMentioned: c.allergy,
      needsStaffReview: c.review,
      forChildren: c.forChildren ?? false,
    },
    run: async (h: ReturnType<typeof evaluationHarness>) => {
      const response = await h.note.analyze({
        sessionId: h.sessionId,
        tableId: h.tableId,
        dishId: h.catalog[0]._id.toString(),
        note: c.note,
      });
      assert.deepEqual(
        [...response.result.modifierTags].sort(),
        [...c.tags].sort(),
      );
      assert.equal(response.result.allergyMentioned, c.allergy);
      if (c.summary) assert.equal(response.result.summary, c.summary);
      if (!c.review && !c.allergy) assert.deepEqual(response.warnings, []);
      if (c.review)
        assert.ok(response.warnings.some((w) => w.includes('xác minh')));
      if (c.allergy)
        assert.ok(
          response.warnings.includes(
            'Không thể xác minh an toàn dị ứng từ dữ liệu hiện có.',
          ),
        );
      assert.ok(response.analysisToken);
    },
  })),
  ...searchCases.map((c) => ({
    id: c.id,
    feature: 'Semantic Search',
    expected: { intent: c.intent, dishes: c.expectedNames },
    output: c.intent,
    run: async (h: ReturnType<typeof evaluationHarness>) => {
      const response = await h.search.search({
        tableId: h.tableId,
        query: c.query,
      });
      assert.deepEqual(
        response.result.dishes.map((d) => d.name).sort(),
        [...c.expectedNames].sort(),
      );
      assert.equal(
        response.fallbackUsed,
        c.intent.unsupportedCriteria.length > 0,
      );
      for (const dish of response.result.dishes) {
        const original = h.catalog.find((d) => d._id.equals(dish._id));
        assert.ok(original, 'dish must originate in repository');
        assert.equal(dish.price, original.price);
        assert.deepEqual(dish.ingredients, original.ingredients ?? []);
        assert.deepEqual(dish.allergenTags, original.allergenTags ?? []);
      }
      if (c.intent.excludedAllergens.length)
        assert.ok(response.warnings.some((w) => w.includes('dị ứng')));
      const parsed = Object.fromEntries(
        Object.entries(c.intent).filter(
          ([k, v]) =>
            k !== 'unsupportedCriteria' &&
            v !== null &&
            (!Array.isArray(v) || v.length),
        ),
      );
      assert.deepEqual(
        response.result.appliedFilters,
        c.intent.unsupportedCriteria.length ? {} : parsed,
        'search filters must express only requested constraints',
      );
    },
  })),
  ...analyticsCases.map((c) => ({
    id: c.id,
    feature: 'Analytics',
    expected: {
      intent: c.intent,
      fact: { metric: c.expectedMetric, value: c.expectedValue },
      grounding:
        'Answer must be an unchanged backend-generated candidate; every numeric fact comes from backend tools.',
    },
    output: c.intent,
    run: async (h: ReturnType<typeof evaluationHarness>) => {
      const response = await h.analytics.query({ query: c.query });
      assert.deepEqual(
        h.outputs.get('admin_analytics_intent'),
        c.intent,
        'analytics intent must match the requested metric and periods',
      );
      if (c.expectedMetric) {
        assert.equal(
          response.facts.find((f) => f.metric === c.expectedMetric)?.value,
          c.expectedValue,
        );
        assert.ok(response.warnings.includes(ANALYTICS_WARNINGS.causes));
        assert.ok(
          response.facts.every(
            (f) => f.value === null || Number.isFinite(f.value),
          ),
        );
      } else assert.deepEqual(response.facts, []);
      assert.ok(
        !/do thời tiết|do nhân viên|db\.users|\$where/.test(
          response.result.answer,
        ),
      );
    },
  })),
  ...reviewCases.map((c) => ({
    id: c.id,
    feature: 'Review Intelligence',
    expected: c.classification,
    output: c.classification,
    run: async (h: ReturnType<typeof evaluationHarness>) => {
      h.setComment(c.comment);
      const response = await h.review.analyze({});
      assert.equal(response.analyzed, 1);
      assert.equal(h.insight()?.sentiment, c.classification.sentiment);
      const sortTopics = (v: unknown) =>
        [...(v as { topic: string; sentiment: string }[])]
          .map(({ topic, sentiment }) => ({ topic, sentiment }))
          .sort((a, b) => a.topic.localeCompare(b.topic));
      assert.deepEqual(
        sortTopics(h.insight()?.topics),
        sortTopics(c.classification.topics),
      );
    },
  })),
  {
    id: 'review-summary-grounding',
    expected: {
      sampleSize: 1,
      commentCount: 2,
      totalReviews: 3,
      analysisCoveragePercentage: 50,
    },
    feature: 'Review Intelligence',
    output: null,
    run: async (h) => {
      const response = await h.review.summary({});
      assert.equal(response.summaryStatus, 'ready');
      assert.equal(response.facts.sampleSize, 1);
      assert.equal(response.facts.commentCount, 2);
      assert.equal(response.facts.totalReviews, 3);
      assert.equal(response.facts.analysisCoveragePercentage, 50);
      assert.ok(response.summary?.includes('1/2 comment trong 3 đánh giá'));
      assert.ok(response.summary?.includes('Chưa đủ dữ liệu'));
    },
  },
];

export function offlineConfig() {
  return new AiConfig(
    new ConfigService({
      AI_ENABLED: 'true',
      AI_PROVIDER: 'openai',
      AI_MODEL: 'fixture-replay',
      AI_API_KEY: 'synthetic-evaluation-key',
      AI_TIMEOUT_MS: '1000',
      AI_MAX_RETRIES: '0',
    }),
  );
}
