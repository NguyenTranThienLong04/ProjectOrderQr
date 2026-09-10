import { AiError } from '../../src/modules/ai/ai.errors';
import type { AiAuditEntry } from '../../src/modules/ai/ai-audit.service';
import {
  diagnosticSanitizer,
  evaluationFailure,
  evaluationFailureCategory,
  installHttpDiagnostics,
} from './live-diagnostics';
import { evaluationCases, evaluationHarness, offlineConfig } from './harness';

describe('Live compatibility diagnostics and behavior evaluation', () => {
  it.each([
    ['AI_PROVIDER_RATE_LIMIT', 'provider_quota_or_network'],
    ['AI_PROVIDER_UNAVAILABLE', 'provider_quota_or_network'],
    ['AI_TIMEOUT', 'provider_quota_or_network'],
    ['AI_INVALID_OUTPUT', 'schema_or_server_validation'],
    ['GOLDEN_MISMATCH', 'golden_semantic'],
  ])('labels %s distinctly as %s', (code, category) => {
    expect(evaluationFailureCategory(code)).toBe(category);
  });
  it('redacts Groq credentials from diagnostics', () => {
    const sanitize = diagnosticSanitizer({ GROQ_API_KEY: 'groq-test-secret' });
    const result = JSON.stringify(
      sanitize({ message: `groq-test-secret gsk_${'a'.repeat(30)}` }),
    );
    expect(result).not.toContain('groq-test-secret');
    expect(result).not.toContain('gsk_');
  });
  afterEach(() => jest.restoreAllMocks());
  it.each([
    'Rare Beef Pho',
    'Pho with rare beef',
    'Phở bò tái — Rare Beef Pho',
  ])(
    'accepts faithful dish name %s without a fixed sentence',
    async (nameEn) => {
      const entry = evaluationCases.find((c) => c.id === 'dish-pho')!;
      const h = evaluationHarness(
        {
          generateStructured: () =>
            Promise.resolve({
              output: {
                nameEn,
                descriptionEn: 'Vietnamese phở with rare beef.',
              },
            }),
        },
        offlineConfig(),
      );
      await expect(entry.run(h)).resolves.toBeUndefined();
    },
  );
  it.each([
    ['Chicken Pho', 'A dish.'],
    ['Beef Pho', 'A dish.'],
    ['Rare Beef Pho', 'Made with peanuts.'],
    ['Rare Beef Pho', 'Gluten-free and healthy.'],
    ['Rare Beef Pho', 'Served with shrimp and fish sauce.'],
  ])(
    'rejects mistranslation or invented facts: %s / %s',
    async (nameEn, descriptionEn) => {
      const entry = evaluationCases.find((c) => c.id === 'dish-pho')!;
      const h = evaluationHarness(
        {
          generateStructured: () =>
            Promise.resolve({ output: { nameEn, descriptionEn } }),
        },
        offlineConfig(),
      );
      await expect(entry.run(h)).rejects.toThrow();
    },
  );
  it('reports provider failure before assertion about an unavailable review', () => {
    const error = Object.assign(new Error('Expected 0 to equal 1'), {
      name: 'AssertionError',
    });
    expect(
      evaluationFailure(error, [
        { success: false, errorCode: 'AI_PROVIDER_RATE_LIMIT' } as AiAuditEntry,
      ]),
    ).toBe('AI_PROVIDER_RATE_LIMIT');
    expect(evaluationFailure(error, [{ success: true } as AiAuditEntry])).toBe(
      'GOLDEN_MISMATCH',
    );
    expect(evaluationFailure(new AiError('AI_TIMEOUT'), [])).toBe('AI_TIMEOUT');
  });
  it('redacts environment secrets, credential patterns, URLs and private keys recursively', () => {
    const sanitize = diagnosticSanitizer({
      GEMINI_API_KEY: 'test-provider-secret',
      JWT_SECRET: 'test-jwt-secret',
    });
    const result = JSON.stringify(
      sanitize({
        message:
          'test-provider-secret test-jwt-secret https://host/path?key=unknown',
        output: {
          nameEn: 'Rare Beef Pho',
          secret: 'do-not-keep',
          nested: [{ apiKey: 'do-not-keep' }],
        },
        text: `AIza${'a'.repeat(30)} sk-${'b'.repeat(20)} eyJhbGc.payload.signature`,
        thought: 'do-not-keep',
      }),
    );
    for (const privateValue of [
      'test-provider-secret',
      'test-jwt-secret',
      'https://host',
      'do-not-keep',
      'AIza',
      'sk-',
      'eyJ',
    ])
      expect(result).not.toContain(privateValue);
    expect(result).toContain('Rare Beef Pho');
  });
  it('observes sanitized HTTP errors and restores transport without storing requests/headers', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: 'test-provider-secret',
            details: [
              { quotaId: 'GenerateRequestsPerMinute', quotaValue: '5' },
            ],
          },
        },
        { status: 429 },
      ),
    );
    const events: unknown[] = [];
    const restore = installHttpDiagnostics(
      events,
      diagnosticSanitizer({ GEMINI_API_KEY: 'test-provider-secret' }),
    );
    try {
      const response = await fetch('https://test.invalid', {
        headers: { authorization: 'private-header' },
      });
      expect(response.status).toBe(429);
      expect(events).toEqual([
        {
          httpStatus: 429,
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: '[REDACTED]',
            details: [
              { quotaId: 'GenerateRequestsPerMinute', quotaValue: '5' },
            ],
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('private-header');
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(fetchMock);
  });
});
