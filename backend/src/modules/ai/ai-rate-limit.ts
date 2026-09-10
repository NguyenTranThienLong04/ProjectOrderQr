import { rateLimit } from 'express-rate-limit';

/** Create once when registering a future AI route, after CORS. Never per request. */
export function createAiRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (request) => request.method === 'OPTIONS',
    message: {
      statusCode: 429,
      code: 'AI_RATE_LIMIT',
      message: 'AI request limit reached. Try again later.',
    },
  });
}
