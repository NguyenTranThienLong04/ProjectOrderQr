import { HttpException } from '@nestjs/common';

const ERRORS = {
  AI_ANALYTICS_UNAVAILABLE: [
    503,
    'Analytics data is temporarily unavailable.',
    false,
  ],
  AI_DISABLED: [503, 'AI is disabled.', false],
  AI_NOT_CONFIGURED: [
    503,
    'AI configuration is unavailable or invalid.',
    false,
  ],
  AI_TIMEOUT: [504, 'AI request timed out.', true],
  AI_RATE_LIMIT: [429, 'AI request limit reached. Try again later.', true],
  AI_PROVIDER_RATE_LIMIT: [
    429,
    'AI provider quota reached. Try again later.',
    true,
  ],
  AI_INVALID_OUTPUT: [502, 'AI returned an invalid structured result.', true],
  AI_PROVIDER_UNAVAILABLE: [
    503,
    'AI provider is temporarily unavailable.',
    true,
  ],
  AI_PROVIDER_AUTH_ERROR: [503, 'AI provider authentication failed.', false],
  AI_INVALID_REQUEST: [400, 'AI request is invalid.', false],
  AI_UNSUPPORTED_FEATURE: [
    422,
    'AI feature or prompt version is unsupported.',
    false,
  ],
  AI_REFUSED: [422, 'AI could not process this request.', false],
  AI_INTERNAL_ERROR: [500, 'AI request could not be completed.', false],
} as const;

export type AiErrorCode = keyof typeof ERRORS;

export class AiError extends HttpException {
  readonly retryable: boolean;

  constructor(readonly code: AiErrorCode) {
    const [status, message, retryable] = ERRORS[code];
    super({ statusCode: status, code, message }, status);
    this.retryable = retryable;
  }
}

// Never retain/log the original exception: vendor messages can echo input/keys.
export function normalizeAiError(error: unknown): AiError {
  return error instanceof AiError ? error : new AiError('AI_INTERNAL_ERROR');
}
