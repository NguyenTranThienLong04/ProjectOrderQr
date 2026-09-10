import { IsInt, Max, Min } from 'class-validator';
import { AiConfig } from '../ai.config';
import { ConfigService } from '@nestjs/config';
import type { AiRequest } from '../ai.types';

export class FoundationOutput {
  @IsInt() @Min(0) @Max(10) value!: number;
}

export const foundationRequest: AiRequest<FoundationOutput> = {
  feature: 'foundation-test',
  promptVersion: 'v1',
  input: 'private customer allergy note; JWT; API key; VNPAY secret',
  output: {
    name: 'foundation_output',
    dto: FoundationOutput,
    jsonSchema: {
      type: 'object',
      properties: { value: { type: 'integer', minimum: 0, maximum: 10 } },
      required: ['value'],
      additionalProperties: false,
    },
  },
};
export const foundationPrompt = {
  feature: foundationRequest.feature,
  promptVersion: 'v1',
  systemPrompt:
    'Internal foundation test only. Return a value in the supplied schema.',
};
export const validAiEnv = {
  AI_ENABLED: 'true',
  AI_PROVIDER: 'openai',
  AI_API_KEY: 'test-only-not-a-real-key',
  AI_MODEL: 'test-model-snapshot',
  AI_TIMEOUT_MS: '100',
  AI_MAX_RETRIES: '1',
};
export function testAiConfig(
  overrides: Record<string, string | undefined> = {},
) {
  const values: Record<string, string | undefined> = {
    ...validAiEnv,
    ...overrides,
  };
  // A small get-only double prevents the developer/CI environment filling gaps.
  const config = {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
  return new AiConfig(config);
}
