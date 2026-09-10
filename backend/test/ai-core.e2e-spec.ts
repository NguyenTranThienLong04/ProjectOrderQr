import 'dotenv/config';
import * as dns from 'dns';
import { randomUUID } from 'crypto';
import { INestApplication, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  getConnectionToken,
  getModelToken,
  MongooseModule,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model, Types } from 'mongoose';
import request from 'supertest';
import type { App } from 'supertest/types';
import { io } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { AppService } from '../src/app.service';
import { DatabaseModule } from '../src/database/database.module';
import { AiConfig } from '../src/modules/ai/ai.config';
import { AiError } from '../src/modules/ai/ai.errors';
import { AiOrchestratorService } from '../src/modules/ai/ai-orchestrator.service';
import { AiPromptRegistry } from '../src/modules/ai/prompts/ai-prompt-registry.service';
import { AI_PROVIDER } from '../src/modules/ai/providers/ai-provider.interface';
import { AiInteraction } from '../src/modules/ai/schemas/ai-interaction.schema';
import { MockAiProvider } from '../src/modules/ai/testing/mock-ai-provider';
import {
  foundationPrompt,
  foundationRequest,
  validAiEnv,
} from '../src/modules/ai/testing/ai-test.fixture';
import { Table } from '../src/modules/table/table.schema';

if (process.env.CUSTOM_DNS_SERVERS)
  dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
jest.setTimeout(60000);
@Module({})
class IsolatedAiCoreDatabaseModule {}

describe('Phase 17 AppModule core isolation (real Mongo/HTTP/Socket)', () => {
  let app: INestApplication<App>;
  let connection: Connection;
  let tables: Model<Table>;
  let audits: Model<AiInteraction>;
  let service: AiOrchestratorService;
  const tableId = new Types.ObjectId();
  const dbName = `smartorder_p17_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const config = new ConfigService({
    ...validAiEnv,
    AI_ENABLED: 'false',
    AI_MAX_RETRIES: '0',
  });
  const provider = new MockAiProvider([new AiError('AI_PROVIDER_UNAVAILABLE')]);

  beforeAll(async () => {
    if (process.env.NODE_ENV === 'production' || !process.env.MONGODB_URI)
      throw new Error('Requires dev/test Mongo; DB name is always overridden');
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Live provider forbidden'));
    const fixture = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(DatabaseModule)
      .useModule({
        module: IsolatedAiCoreDatabaseModule,
        imports: [
          MongooseModule.forRoot(process.env.MONGODB_URI, {
            dbName,
            retryAttempts: 0,
            serverSelectionTimeoutMS: 15000,
          }),
        ],
      })
      .overrideProvider(AiConfig)
      .useValue(new AiConfig(config))
      .overrideProvider(AI_PROVIDER)
      .useValue(provider)
      .compile();
    // This regression needs core services, not bootstrap demo staff creation.
    jest
      .spyOn(fixture.get(AppService), 'onApplicationBootstrap')
      .mockResolvedValue(undefined);
    app = fixture.createNestApplication<INestApplication<App>>();
    await app.listen(0, '127.0.0.1');
    connection = fixture.get(getConnectionToken());
    expect(connection.name).toBe(dbName);
    tables = fixture.get(getModelToken(Table.name));
    audits = fixture.get(getModelToken(AiInteraction.name));
    await audits.init();
    await tables.create({
      _id: tableId,
      tableCode: 'P17-CORE',
      qrCodeUrl: 'data:image/png;base64,test',
    });
    fixture.get(AiPromptRegistry).register(foundationPrompt);
    service = fixture.get(AiOrchestratorService);
  });
  afterAll(async () => {
    try {
      if (tables) await tables.deleteOne({ _id: tableId });
      if (audits) {
        const entries = await audits
          .find({ feature: foundationPrompt.feature })
          .select('_id')
          .lean();
        await audits.deleteMany({
          _id: { $in: entries.map((entry) => entry._id) },
        });
      }
      if (connection) {
        for (const collection of Object.values(connection.collections))
          expect(await collection.countDocuments()).toBe(0);
      }
    } finally {
      if (app) await app.close();
      jest.restoreAllMocks();
    }
  });
  it.each(['AI_DISABLED', 'AI_NOT_CONFIGURED', 'AI_PROVIDER_UNAVAILABLE'])(
    'keeps root/menu/table data working after %s',
    async (code) => {
      config.set('AI_ENABLED', code === 'AI_DISABLED' ? 'false' : 'true');
      config.set(
        'AI_API_KEY',
        code === 'AI_NOT_CONFIGURED' ? '' : validAiEnv.AI_API_KEY,
      );
      const before = await tables.findById(tableId).lean();
      await expect(
        service.generateStructured(foundationRequest),
      ).rejects.toMatchObject({ code });
      await request(app.getHttpServer())
        .get('/')
        .expect(200)
        .expect('Hello World!');
      const menu = await request(app.getHttpServer())
        .get('/menu')
        .query({ tableId: tableId.toString() })
        .expect(200);
      expect(menu.body).toMatchObject({
        table: { id: tableId.toString(), tableCode: 'P17-CORE' },
        categories: [],
      });
      expect(await tables.findById(tableId).lean()).toEqual(before);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );
  it('keeps real Socket transport available and exposes no generic AI chat endpoint', async () => {
    const socket = io(await app.getUrl(), {
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      expect(socket.connected).toBe(true);
      await request(app.getHttpServer())
        .post('/ai/chat')
        .send({ input: 'test' })
        .expect(404);
      expect(provider.calls).toHaveLength(1);
    } finally {
      socket.disconnect();
    }
  });
});
