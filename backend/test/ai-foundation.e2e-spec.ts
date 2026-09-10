import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import { AiModule } from '../src/modules/ai/ai.module';
import { AiOrchestratorService } from '../src/modules/ai/ai-orchestrator.service';
import { AiError } from '../src/modules/ai/ai.errors';
import { AiPromptRegistry } from '../src/modules/ai/prompts/ai-prompt-registry.service';
import { AI_PROVIDER } from '../src/modules/ai/providers/ai-provider.interface';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import { MockAiProvider } from '../src/modules/ai/testing/mock-ai-provider';
import {
  foundationPrompt,
  foundationRequest,
  validAiEnv,
} from '../src/modules/ai/testing/ai-test.fixture';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);

/** Real Mongo, unique test DB override. Never boots business workers/seeds. */
describe('Phase 17 AI module + real audit persistence', () => {
  const dbName = `smartorder_p17_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const ids: Types.ObjectId[] = [];
  let fixture: TestingModule;
  let interactions: Model<AiInteraction>;
  let service: AiOrchestratorService;
  const config = new ConfigService({ ...validAiEnv, AI_MAX_RETRIES: '0' });
  const provider = new MockAiProvider([
    { output: { value: 4 }, usage: { inputTokens: 11, outputTokens: 3 } },
    new AiError('AI_PROVIDER_AUTH_ERROR'),
    { output: { value: 'bad' } },
  ]);
  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production')
      throw new Error('AI integration test is forbidden in production');
    if (!process.env.MONGODB_URI)
      throw new Error(
        'MONGODB_URI is required; DB name is always overridden for this test',
      );
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(
        new Error('Live provider forbidden in integration tests'),
      );
    fixture = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(process.env.MONGODB_URI, {
          dbName,
          retryAttempts: 0,
          serverSelectionTimeoutMS: 15000,
        }),
        AiModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    await fixture.init();
    interactions = fixture.get(getModelToken(AiInteraction.name));
    await interactions.init();
    fixture.get(AiPromptRegistry).register(foundationPrompt);
    service = fixture.get(AiOrchestratorService);
  });
  afterAll(async () => {
    try {
      if (interactions) {
        const documents = await interactions
          .find({ feature: foundationPrompt.feature })
          .lean();
        ids.push(...documents.map((document) => document._id));
        await interactions.deleteMany({ _id: { $in: ids } });
        expect(await interactions.countDocuments()).toBe(0);
      }
    } finally {
      if (fixture) await fixture.close();
      jest.restoreAllMocks();
    }
  });
  it('uses isolated configured connection and persists success metadata/real tokens', async () => {
    expect(fixture.get<Connection>(getConnectionToken()).name).toBe(dbName);
    expect(await service.generateStructured(foundationRequest)).toMatchObject({
      result: { value: 4 },
      fallbackUsed: false,
    });
    const persisted = await interactions.findOne({ success: true }).lean();
    expect(persisted).toMatchObject({
      feature: 'foundation-test',
      provider: 'openai',
      model: 'test-model-snapshot',
      promptVersion: 'v1',
      latencyMs: expect.any(Number) as unknown,
      inputTokens: 11,
      outputTokens: 3,
      attempts: 1,
      createdAt: expect.any(Date) as unknown,
    });
  });
  it('persists provider failure and invalid output as controlled errors', async () => {
    for (const code of ['AI_PROVIDER_AUTH_ERROR', 'AI_INVALID_OUTPUT']) {
      await expect(
        service.generateStructured(foundationRequest),
      ).rejects.toMatchObject({ code });
      expect(
        await interactions.findOne({ errorCode: code }).lean(),
      ).toMatchObject({ success: false, attempts: 1, promptVersion: 'v1' });
    }
  });
  it('disabled and missing credentials remain controlled with zero provider attempts', async () => {
    config.set('AI_ENABLED', 'false');
    await expect(
      service.generateStructured(foundationRequest),
    ).rejects.toMatchObject({ code: 'AI_DISABLED' });
    config.set('AI_ENABLED', 'true');
    config.set('AI_API_KEY', '');
    await expect(
      service.generateStructured(foundationRequest),
    ).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(
      await interactions.countDocuments({ attempts: 0, success: false }),
    ).toBe(2);
    expect(provider.calls).toHaveLength(3);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('stores no raw input, system prompt, response, confidence or secrets', async () => {
    const documents = await interactions.find().lean();
    expect(documents).toHaveLength(5);
    const serialized = JSON.stringify(documents);
    for (const forbidden of [
      foundationRequest.input,
      foundationPrompt.systemPrompt,
      validAiEnv.AI_API_KEY,
      'chainOfThought',
      'confidence',
      'systemPrompt',
      'rawPrompt',
    ])
      expect(serialized).not.toContain(forbidden);
    expect(
      documents
        .filter((document) => !document.success)
        .every((document) => document.inputTokens === undefined),
    ).toBe(true);
  });
});
