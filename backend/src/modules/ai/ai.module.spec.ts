import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { model } from 'mongoose';
import express from 'express';
import request from 'supertest';
import { AiModule } from './ai.module';
import { AiConfig } from './ai.config';
import { AiError } from './ai.errors';
import { AiAuditService } from './ai-audit.service';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { AiPromptRegistry } from './prompts/ai-prompt-registry.service';
import { AI_PROVIDER } from './providers/ai-provider.interface';
import { OpenAiProvider } from './providers/openai-provider.service';
import { GeminiProvider } from './providers/gemini-provider.service';
import { GroqProvider } from './providers/groq-provider.service';
import { AiProviderResolver } from './providers/ai-provider-resolver.service';
import { testAiConfig } from './testing/ai-test.fixture';
import {
  AiInteraction,
  AiInteractionSchema,
} from './schemas/ai-interaction.schema';
import { MockAiProvider } from './testing/mock-ai-provider';
import {
  foundationPrompt,
  foundationRequest,
  validAiEnv,
} from './testing/ai-test.fixture';
import { createAiRateLimiter } from './ai-rate-limit';

describe('AiModule DI and audit', () => {
  const auditModel = model(AiInteraction.name, AiInteractionSchema);
  afterEach(() => jest.restoreAllMocks());
  it('compiles with concrete adapter while AI disabled and exposes no chatbot route', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('No network allowed'));
    const fixture = await Test.createTestingModule({ imports: [AiModule] })
      .overrideProvider(getModelToken(AiInteraction.name))
      .useValue(auditModel)
      .overrideProvider(ConfigService)
      .useValue(new ConfigService({ AI_ENABLED: 'false' }))
      .compile();
    const insert = jest
      .spyOn(auditModel.collection, 'insertOne')
      .mockResolvedValue({
        acknowledged: true,
        insertedId: new auditModel()._id,
      });
    const app = fixture.createNestApplication();
    await app.init();
    try {
      expect(fixture.get(AI_PROVIDER)).toBeInstanceOf(AiProviderResolver);
      await expect(
        fixture
          .get(AiOrchestratorService)
          .generateStructured(foundationRequest),
      ).rejects.toMatchObject({ code: 'AI_DISABLED' });
      await request(app.getHttpServer() as express.Express)
        .post('/ai/chat')
        .send({ input: 'test' })
        .expect(404);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it.each(['openai', 'gemini', 'groq', 'unknown'])(
    'resolves %s through real DI without startup network',
    async (selected) => {
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('No network'));
      const config = testAiConfig({
        AI_PROVIDER: selected,
        GEMINI_API_KEY: 'gemini-test-only',
        GEMINI_MODEL: 'gemini-3.7-flash',
        GROQ_API_KEY: 'groq-test-only',
      });
      const fixture = await Test.createTestingModule({ imports: [AiModule] })
        .overrideProvider(getModelToken(AiInteraction.name))
        .useValue(auditModel)
        .overrideProvider(AiConfig)
        .useValue(config)
        .compile();
      try {
        const resolver = fixture.get<AiProviderResolver>(AI_PROVIDER);
        if (selected === 'unknown') {
          expect(() => resolver.resolve()).toThrow(
            new AiError('AI_NOT_CONFIGURED'),
          );
        } else {
          expect(resolver.resolve()).toBe(
            fixture.get(
              selected === 'groq'
                ? GroqProvider
                : selected === 'gemini'
                  ? GeminiProvider
                  : OpenAiProvider,
            ),
          );
        }
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await fixture.close();
      }
    },
  );
  it('resolves mock through real module and persists only validated audit fields', async () => {
    const insert = jest
      .spyOn(auditModel.collection, 'insertOne')
      .mockResolvedValue({
        acknowledged: true,
        insertedId: new auditModel()._id,
      });
    const fixture = await Test.createTestingModule({ imports: [AiModule] })
      .overrideProvider(getModelToken(AiInteraction.name))
      .useValue(auditModel)
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(validAiEnv))
      .overrideProvider(AI_PROVIDER)
      .useValue(new MockAiProvider([{ output: { value: 2 } }]))
      .compile();
    try {
      fixture.get(AiPromptRegistry).register(foundationPrompt);
      await expect(
        fixture
          .get(AiOrchestratorService)
          .generateStructured(foundationRequest),
      ).resolves.toMatchObject({ result: { value: 2 } });
      const entry = insert.mock.calls[0][0];
      expect(entry).toMatchObject({
        feature: 'foundation-test',
        model: 'test-model-snapshot',
        promptVersion: 'v1',
        success: true,
        createdAt: expect.any(Date) as unknown,
      });
      expect(Object.keys(entry).sort()).toEqual(
        [
          '_id',
          'attempts',
          'createdAt',
          'fallbackUsed',
          'feature',
          'latencyMs',
          'model',
          'promptVersion',
          'provider',
          'success',
        ].sort(),
      );
      expect(insert.mock.calls[0][1]).toEqual({ timeoutMS: 1500 });
    } finally {
      await fixture.close();
    }
  });
  it('audit allowlist drops extra runtime properties and logs only static code on write failure', async () => {
    const insert = jest
      .spyOn(auditModel.collection, 'insertOne')
      .mockRejectedValue(new Error('raw prompt key and connection secret'));
    const warning = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const audit = new AiAuditService(auditModel);
    const entry = {
      feature: 'foundation-test',
      provider: 'openai',
      model: 'test-model-snapshot',
      promptVersion: 'v1',
      latencyMs: 5,
      attempts: 1,
      fallbackUsed: false,
      success: false,
      rawPrompt: 'private health note',
      apiKey: 'secret',
      systemPrompt: 'internal',
    };
    expect(await audit.record(entry)).toBe(false);
    expect(JSON.stringify(insert.mock.calls)).not.toContain(
      'private health note',
    );
    expect(warning).toHaveBeenCalledWith('AI_AUDIT_WRITE_FAILED');
    expect(warning).toHaveBeenCalledTimes(1);
  });
});

describe('Future AI route throttle HTTP pattern', () => {
  it('limits only mounted AI route, excludes OPTIONS and keeps other core requests working', async () => {
    const app = express();
    app.use('/test-ai', createAiRateLimiter());
    app.all('/test-ai', (_req, res) => res.json({ ok: true }));
    app.get('/test-core', (_req, res) => res.json({ ok: true }));
    for (let index = 0; index < 15; index++)
      await request(app).options('/test-ai').expect(200);
    for (let index = 0; index < 10; index++)
      await request(app).post('/test-ai').expect(200);
    const limited = await request(app).post('/test-ai').expect(429);
    expect(limited.body).toMatchObject({ code: 'AI_RATE_LIMIT' });
    await request(app).get('/test-core').expect(200);
    await request(app).options('/test-ai').expect(200);
  });
});
