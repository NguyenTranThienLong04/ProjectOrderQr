import { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Dish } from '../../dish/dish.schema';
import { DISH_MODIFIERS } from '../../dish/dish-metadata';
import { Session } from '../../session/session.schema';
import { Table } from '../../table/table.schema';
import { AiError } from '../ai.errors';
import { AI_PROVIDER } from '../providers/ai-provider.interface';
import {
  AiInteraction,
  AiInteractionSchema,
} from '../schemas/ai-interaction.schema';
import { MockAiProvider, type MockAiStep } from '../testing/mock-ai-provider';
import { validAiEnv } from '../testing/ai-test.fixture';
import { OrderNoteAiModule } from './order-note-ai.module';
import { ORDER_NOTE_GOLDEN_V2 } from './order-note.golden';
import { safeOrderNoteResult } from './order-note-safety';

type NoteBody = {
  result: {
    summary: string;
    modifierTags: string[];
    allergyMentioned: boolean;
  };
  warnings: string[];
  code?: string;
};
const body = (response: { body: unknown }) => response.body as NoteBody;
const providerInput = (input: string) => JSON.parse(input) as { note: string };

describe('Phase 19 HTTP ownership/structured/audit contract (mock DB/provider)', () => {
  let app: INestApplication<App>;
  let config: ConfigService;
  const auditModel = model('NoteContractAudit', AiInteractionSchema);
  const sessionId = new Types.ObjectId();
  const tableId = new Types.ObjectId();
  const dishId = new Types.ObjectId();
  const base = {
    sessionId: sessionId.toString(),
    tableId: tableId.toString(),
    dishId: dishId.toString(),
    note: 'không hành',
  };
  const steps: MockAiStep[] = [];
  let provider: MockAiProvider;
  let insert: jest.SpyInstance<unknown, [Record<string, unknown>, unknown?]>;
  const sessionExec = jest.fn();
  const tableExec = jest.fn();
  const dishExec = jest.fn();
  const findSession = jest.fn(() => ({ exec: sessionExec }));
  const findDish = jest.fn(() => ({ exec: dishExec }));
  const post = (body: object = base) =>
    request(app.getHttpServer()).post('/ai/order-notes/analyze').send(body);
  const output = {
    modifierTags: ['NO_ONION'],
    allergyMentioned: false,
    forChildren: false,
    needsStaffReview: false,
  };
  beforeEach(async () => {
    steps.length = 0;
    provider = new MockAiProvider(steps);
    config = new ConfigService({ ...validAiEnv, AI_MAX_RETRIES: '0' });
    sessionExec.mockResolvedValue({ tableId, tableIds: [tableId] });
    tableExec.mockResolvedValue({ currentSessionId: sessionId });
    dishExec.mockResolvedValue({
      availableModifiers: DISH_MODIFIERS,
      allergenTags: ['peanut'],
    });
    insert = jest.spyOn(auditModel.collection, 'insertOne').mockResolvedValue({
      acknowledged: true,
      insertedId: new Types.ObjectId(),
    });
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Live fetch forbidden'));
    const fixture = await Test.createTestingModule({
      imports: [ConfigModule, OrderNoteAiModule],
    })
      .overrideProvider(getModelToken(AiInteraction.name))
      .useValue(auditModel)
      .overrideProvider(getModelToken(Session.name))
      .useValue({ findOne: findSession })
      .overrideProvider(getModelToken(Table.name))
      .useValue({ findById: () => ({ exec: tableExec }) })
      .overrideProvider(getModelToken(Dish.name))
      .useValue({ findOne: findDish })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    app = fixture.createNestApplication<INestApplication<App>>();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });
  it('valid ownership resolves real available dish, returns safe summary/receipt and versioned private audit', async () => {
    steps.push({ output, usage: { inputTokens: 25, outputTokens: 8 } });
    const res = await post().expect(200);
    expect(body(res)).toMatchObject({
      result: { summary: 'Không hành', modifierTags: ['NO_ONION'] },
      modelVersion: 'openai:test-model-snapshot:order-note-v2',
      fallbackUsed: false,
      analysisToken: expect.any(String) as unknown,
    });
    expect(findSession).toHaveBeenCalledWith({
      _id: base.sessionId,
      status: 'active',
    });
    expect(findDish).toHaveBeenCalledWith({
      _id: base.dishId,
      isAvailable: true,
    });
    expect(providerInput(provider.calls[0].input)).toEqual({
      note: base.note,
      taxonomy: expect.any(Array) as unknown,
      availableModifiers: DISH_MODIFIERS,
    });
    expect(insert.mock.calls[0][0]).toMatchObject({
      feature: 'order-note',
      promptVersion: 'order-note-v2',
      success: true,
      inputTokens: 25,
      outputTokens: 8,
    });
    expect(JSON.stringify(insert.mock.calls)).not.toContain(base.note);
    expect(JSON.stringify(insert.mock.calls)).not.toContain(base.sessionId);
  });
  it.each([
    'missing-session',
    'closed-session',
    'missing-table',
    'wrong-table',
    'wrong-current-session',
  ])('rejects %s before provider', async (kind) => {
    if (kind.includes('session') && !kind.includes('current'))
      sessionExec.mockResolvedValue(null);
    if (kind === 'missing-table') tableExec.mockResolvedValue(null);
    if (kind === 'wrong-current-session')
      tableExec.mockResolvedValue({ currentSessionId: new Types.ObjectId() });
    if (kind === 'wrong-table')
      sessionExec.mockResolvedValue({
        tableId: new Types.ObjectId(),
        tableIds: [],
      });
    await post().expect(403);
    expect(provider.calls).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
  });
  it('accepts a member table of a merged session and legacy primary table', async () => {
    sessionExec
      .mockResolvedValueOnce({
        tableId: new Types.ObjectId(),
        tableIds: [tableId],
      })
      .mockResolvedValueOnce({ tableId });
    steps.push({ output }, { output });
    await post().expect(200);
    await post().expect(200);
  });
  it('rejects missing or unavailable dish before provider', async () => {
    dishExec.mockResolvedValue(null);
    await post().expect(404);
    expect(provider.calls).toHaveLength(0);
  });
  it.each([
    { note: '' },
    { note: '   ' },
    { note: null },
    { note: 42 },
    { note: 'a'.repeat(251) },
    { note: '😀'.repeat(126) },
    { dishId: 'bad' },
    { sessionId: 'bad' },
    { tableId: 'bad' },
    { availableModifiers: ['NO_ONION'] },
    { allergenTags: [] },
    { summary: 'safe' },
  ])('rejects invalid input %j', async (change) => {
    await post({ ...base, ...change }).expect(400);
    expect(provider.calls).toHaveLength(0);
  });
  it('uses only existing trim normalization, allows 250 and does not rewrite original text', async () => {
    steps.push({ output });
    const note = 'x'.repeat(250);
    await post({ ...base, note: `  ${note}  ` }).expect(200);
    expect(providerInput(provider.calls[0].input).note).toBe(note);
  });
  it.each(ORDER_NOTE_GOLDEN_V2)('golden fixture: $note', async (golden) => {
    steps.push({
      output: {
        modifierTags: [...golden.tags],
        allergyMentioned: golden.allergy,
        needsStaffReview: golden.review,
        forChildren: golden.forChildren ?? false,
      },
    });
    const res = await post({ ...base, note: golden.note }).expect(200);
    expect(body(res).result.modifierTags).toEqual(golden.tags);
    expect(body(res).result.allergyMentioned).toBe(golden.allergy);
    if (golden.summary) expect(body(res).result.summary).toBe(golden.summary);
    if (!golden.review && !golden.allergy)
      expect(body(res).warnings).toEqual([]);
    expect(providerInput(provider.calls[0].input).note).toBe(golden.note);
    expect(provider.calls[0].systemPrompt).toContain('untrusted');
    expect(JSON.stringify(insert.mock.calls)).not.toContain(golden.note);
  });
  it('filters unsupported taxonomy modifiers and warns instead of pretending support', async () => {
    dishExec.mockResolvedValue({ availableModifiers: [], allergenTags: [] });
    steps.push({ output });
    const res = await post().expect(200);
    expect(body(res).result.modifierTags).toEqual([]);
    expect(body(res).warnings.join(' ')).toContain('chưa hỗ trợ');
  });
  it.each(ORDER_NOTE_GOLDEN_V2.filter((c) => c.summary && c.tags.length))(
    'preserves meaning with no supported modifiers: $note',
    async (golden) => {
      dishExec.mockResolvedValue({ availableModifiers: [] });
      steps.push({
        output: {
          modifierTags: [...golden.tags],
          forChildren: golden.forChildren ?? false,
          allergyMentioned: golden.allergy,
          needsStaffReview: golden.review,
        },
      });
      const res = await post({ ...base, note: golden.note }).expect(200);
      expect(body(res).result).toEqual({
        summary: golden.summary,
        modifierTags: [],
        allergyMentioned: false,
      });
      expect(body(res).warnings).toHaveLength(golden.tags.length);
      for (const tag of golden.tags) {
        expect(body(res).warnings.join(' ')).toContain(tag);
      }
      expect(body(res).warnings.join(' ')).toContain(
        'xác minh khả năng đáp ứng',
      );
      expect(body(res).warnings.join(' ')).not.toContain('Yêu cầu có chi tiết');
    },
  );
  it('does not substitute NO_CHILI or LESS_SPICY when NO_SPICE is unavailable', async () => {
    dishExec.mockResolvedValue({
      availableModifiers: ['NO_CHILI', 'LESS_SPICY'],
    });
    steps.push({
      output: { ...output, modifierTags: ['NO_SPICE'], forChildren: true },
    });
    const res = await post({ ...base, note: 'bé ăn không cay' }).expect(200);
    expect(body(res).result).toEqual({
      summary: 'Không cay; dành cho trẻ em',
      modifierTags: [],
      allergyMentioned: false,
    });
    expect(body(res).warnings).toHaveLength(1);
    expect(body(res).warnings[0]).toContain('NO_SPICE');
  });
  it.each(['dị ứng đậu phộng rất nặng', 'dị ứng hải sản', 'không ăn được sữa'])(
    'deterministically catches allergy even if model misses: %s',
    async (note) => {
      steps.push({ output });
      const res = await post({ ...base, note }).expect(200);
      expect(body(res).result.allergyMentioned).toBe(true);
      expect(body(res).warnings.join(' ')).toContain('xác minh trực tiếp');
      if (note.includes('đậu phộng'))
        expect(body(res).warnings.join(' ')).toContain(
          'ghi nhận allergen đậu phộng',
        );
    },
  );
  it('never assumes safety when DB metadata is missing', async () => {
    dishExec.mockResolvedValue({ availableModifiers: [] });
    steps.push({ output });
    const res = await post({ ...base, note: 'dị ứng đậu phộng' }).expect(200);
    expect(body(res).warnings.join(' ')).toContain(
      'Không thể xác minh an toàn',
    );
    expect(body(res).warnings.join(' ')).not.toContain('ghi nhận allergen');
  });
  it.each([
    {},
    { ...output, modifierTags: ['FREE_FORM'] },
    { ...output, modifierTags: ['NO_ONION', 'NO_ONION'] },
    { ...output, allergyMentioned: 'false' },
    { ...output, forChildren: 'true' },
    { ...output, forChildren: undefined },
    { ...output, summary: 'Món này an toàn' },
  ])(
    'rejects invalid/medical prose output inside orchestrator: %j',
    async (invalid) => {
      steps.push({ output: invalid });
      const res = await post().expect(502);
      expect(body(res).code).toBe('AI_INVALID_OUTPUT');
      expect(insert.mock.calls[0][0]).toMatchObject({
        success: false,
        errorCode: 'AI_INVALID_OUTPUT',
      });
    },
  );
  it.each(['AI_ENABLED', 'AI_API_KEY'])(
    'fails gracefully for disabled/missing config %s',
    async (field) => {
      config.set(field, field === 'AI_ENABLED' ? 'false' : '');
      await post().expect(503);
      expect(provider.calls).toHaveLength(0);
    },
  );
  it('maps provider unavailable without raw error leakage', async () => {
    steps.push(new AiError('AI_PROVIDER_UNAVAILABLE'));
    const res = await post().expect(503);
    expect(body(res).code).toBe('AI_PROVIDER_UNAVAILABLE');
  });
  it('bounds timeout, aborts and audits failure', async () => {
    config.set('AI_TIMEOUT_MS', '100');
    steps.push(() => new Promise(() => {}));
    await post().expect(504);
    expect(provider.calls[0].signal.aborted).toBe(true);
    expect(insert.mock.calls[0][0]).toMatchObject({
      success: false,
      errorCode: 'AI_TIMEOUT',
    });
  });
  it('applies separate 10/min endpoint limit', async () => {
    for (let i = 0; i < 10; i++) {
      steps.push({ output });
      await post().expect(200);
    }
    await post().expect(429);
    expect(provider.calls).toHaveLength(10);
  });
});

describe('Conservative negation vetoes against incorrect model tags', () => {
  it.each([
    'không phải không cay',
    'không cần ít cay',
    'không cay nhưng thêm cay',
  ])('vetoes NO_SPICE in both tags and summary for %s', (note) => {
    const safe = safeOrderNoteResult(
      note,
      {
        modifierTags: ['NO_SPICE', 'LESS_SPICY', 'NO_CHILI'],
        allergyMentioned: false,
        forChildren: false,
        needsStaffReview: false,
      },
      DISH_MODIFIERS,
    );
    expect(safe.result.modifierTags).toEqual([]);
    expect(safe.result.summary).toBe('Nhân viên vui lòng xem ghi chú gốc.');
    expect(safe.warnings).toHaveLength(1);
  });
  it('keeps specific unsupported warnings alongside review for other unresolved instructions', () => {
    const safe = safeOrderNoteResult(
      'không cay, giao đến nhà',
      {
        modifierTags: ['NO_SPICE'],
        forChildren: false,
        allergyMentioned: false,
        needsStaffReview: true,
      },
      [],
    );
    expect(safe.result.summary).toBe('Không cay');
    expect(safe.warnings).toHaveLength(2);
    expect(safe.warnings[0]).toContain('NO_SPICE');
    expect(safe.warnings[1]).toContain('Yêu cầu có chi tiết');
  });
  it('matches uppercase Vietnamese allergen mentions deterministically', () => {
    const result = safeOrderNoteResult(
      'DỊ ỨNG ĐẬU PHỘNG RẤT NẶNG',
      {
        modifierTags: [],
        allergyMentioned: false,
        forChildren: false,
        needsStaffReview: false,
      },
      [],
      ['peanut'],
    );
    expect(result.result.allergyMentioned).toBe(true);
    expect(result.warnings.join(' ')).toContain('ghi nhận allergen đậu phộng');
  });
  it.each(['không cay', 'không phải không cay', 'không cần ít cay'])(
    'vetoes incorrect spice classification: %s',
    (note) => {
      expect(
        safeOrderNoteResult(
          note,
          {
            modifierTags: ['LESS_SPICY', 'NO_CHILI'],
            allergyMentioned: false,
            forChildren: false,
            needsStaffReview: false,
          },
          DISH_MODIFIERS,
        ).result.modifierTags,
      ).toEqual([]);
    },
  );
  it.each(['không hành nhưng thêm hành phi', 'thêm hành, không hành phi'])(
    'vetoes incorrect onion classification: %s',
    (note) => {
      expect(
        safeOrderNoteResult(
          note,
          {
            modifierTags: ['NO_ONION'],
            allergyMentioned: false,
            forChildren: false,
            needsStaffReview: false,
          },
          DISH_MODIFIERS,
        ).result.modifierTags,
      ).toEqual([]);
    },
  );
});
