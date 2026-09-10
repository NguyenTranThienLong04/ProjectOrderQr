import type {
  AiProvider,
  AiProviderRequest,
  AiProviderResult,
} from '../providers/ai-provider.interface';

export type MockAiStep =
  | AiProviderResult
  | Error
  | ((request: AiProviderRequest) => Promise<AiProviderResult>);

/** Deterministic test double only. Never registered by production AiModule. */
export class MockAiProvider implements AiProvider {
  readonly calls: AiProviderRequest[] = [];
  constructor(private readonly steps: MockAiStep[]) {}

  async generateStructured(
    request: AiProviderRequest,
  ): Promise<AiProviderResult> {
    this.calls.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error('MockAiProvider has no remaining steps');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(request) : step;
  }
}
