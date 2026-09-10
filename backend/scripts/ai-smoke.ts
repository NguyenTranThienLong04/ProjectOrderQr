import 'dotenv/config';
import * as dns from 'dns';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { IsIn } from 'class-validator';
import { DatabaseModule } from '../src/database/database.module';
import { AiConfig, AI_PROVIDER_SETTINGS } from '../src/modules/ai/ai.config';
import { AiModule } from '../src/modules/ai/ai.module';
import { AiOrchestratorService } from '../src/modules/ai/ai-orchestrator.service';
import { normalizeAiError } from '../src/modules/ai/ai.errors';
import { AiPromptRegistry } from '../src/modules/ai/prompts/ai-prompt-registry.service';

class SmokeOutput {
  @IsIn(['ok']) status!: 'ok';
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, AiModule],
})
class AiSmokeModule {}

async function main() {
  const config = new AiConfig(new ConfigService());
  const { provider } = config.metadata();
  const credential =
    provider === 'unknown'
      ? undefined
      : process.env[AI_PROVIDER_SETTINGS[provider].apiKey];
  if (!credential?.trim() || credential.trim().startsWith('<')) {
    console.log('Live provider: NOT VERIFIED — credential unavailable');
    process.exitCode = 1;
    return;
  }
  if (
    process.env.AI_SMOKE_ALLOW_NETWORK !== 'yes' ||
    !['development', 'test'].includes(process.env.NODE_ENV ?? '')
  ) {
    console.log(
      'Live smoke requires NODE_ENV=development|test and AI_SMOKE_ALLOW_NETWORK=yes. It sends synthetic text and writes one audit to the configured database.',
    );
    process.exitCode = 1;
    return;
  }
  config.requireEnabled();
  if (process.env.CUSTOM_DNS_SERVERS)
    dns.setServers(process.env.CUSTOM_DNS_SERVERS.split(','));
  const context = await NestFactory.createApplicationContext(AiSmokeModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    context.get(AiPromptRegistry).register({
      feature: 'foundation-smoke',
      promptVersion: 'v1',
      systemPrompt:
        'Return the readiness marker ok in the supplied structured schema.',
    });
    const response = await context
      .get(AiOrchestratorService)
      .generateStructured({
        feature: 'foundation-smoke',
        promptVersion: 'v1',
        input: 'Perform the synthetic readiness check.',
        output: {
          name: 'foundation_smoke',
          dto: SmokeOutput,
          jsonSchema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      });
    console.log(
      JSON.stringify({
        liveProvider: 'VERIFIED',
        modelVersion: response.modelVersion,
        warnings: response.warnings,
      }),
    );
    if (response.warnings?.length) process.exitCode = 1;
  } finally {
    await context.close();
  }
}

void main().catch((error: unknown) => {
  console.error(normalizeAiError(error).code);
  process.exitCode = 1;
});
