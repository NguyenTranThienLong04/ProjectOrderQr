import type { AiAuditEntry } from '../../src/modules/ai/ai-audit.service';
import { analyticsIntent } from '../../src/modules/ai/admin-analytics/analytics.golden';
import { emptyMenuIntent } from '../../src/modules/ai/menu-search/menu-search.golden';
import {
  candidate,
  evaluationCases,
  evaluationHarness,
  offlineConfig,
} from './harness';
import { caseDiagnostic, diagnosticSanitizer } from './live-diagnostics';

describe('Groq observed semantic failures (offline regression)', () => {
  it('rejects fresh instead of rare even with valid DTO fields', async () => {
    const entry = evaluationCases.find((c) => c.id === 'dish-pho')!;
    const h = evaluationHarness(
      {
        generateStructured: () =>
          Promise.resolve({
            output: {
              nameEn: 'Fresh Beef Phở',
              descriptionEn:
                'A steaming bowl of phở featuring fresh, tender beef slices and fragrant broth.',
            },
          }),
      },
      offlineConfig(),
    );
    await expect(entry.run(h)).rejects.toThrow('culinary identity missing');
    expect(h.audits.every((audit) => audit.success)).toBe(true);
  });
  it('rejects an unrequested catalog category on a price-only query', async () => {
    const entry = evaluationCases.find((c) => c.id === 'search-budget')!;
    const h = evaluationHarness(
      {
        generateStructured: () =>
          Promise.resolve({
            output: {
              ...emptyMenuIntent(),
              maxPrice: 100000,
              categories: ['Món ăn'],
            },
          }),
      },
      offlineConfig(),
    );
    await expect(entry.run(h)).rejects.toThrow(
      'search filters must express only requested constraints',
    );
    expect(h.audits.every((audit) => audit.success)).toBe(true);
  });
  it('rejects today for an unspecified period while preserving successful narrative grounding', async () => {
    const entry = evaluationCases.find((c) => c.id === 'analytics-revenue')!;
    const h = evaluationHarness(
      {
        generateStructured: (req) =>
          Promise.resolve(
            req.schemaName === 'admin_analytics_intent'
              ? {
                  output: analyticsIntent({
                    currentPeriod: { preset: 'today', from: '', to: '' },
                  }),
                }
              : candidate(req),
          ),
      },
      offlineConfig(),
    );
    await expect(entry.run(h)).rejects.toThrow(
      'analytics intent must match the requested metric and periods',
    );
    expect(h.audits).toHaveLength(2);
    expect(h.audits.every((audit) => audit.success)).toBe(true);
    expect(h.outputs.get('admin_analytics_answer')).toMatchObject({
      answer: expect.stringContaining('300.000 VND') as unknown,
    });
  });
  it('accepts backend-formatted 300.000 VND for the 300000 fact with the requested period', async () => {
    const entry = evaluationCases.find((c) => c.id === 'analytics-revenue')!;
    const h = evaluationHarness(
      {
        generateStructured: (req) =>
          Promise.resolve(
            req.schemaName === 'admin_analytics_intent'
              ? { output: analyticsIntent() }
              : candidate(req),
          ),
      },
      offlineConfig(),
    );
    await expect(entry.run(h)).resolves.toBeUndefined();
    expect(h.outputs.get('admin_analytics_answer')).toMatchObject({
      answer: expect.stringContaining('300.000 VND') as unknown,
    });
  });
  it('still rejects a fabricated number in an otherwise grounded narrative', async () => {
    const entry = evaluationCases.find((c) => c.id === 'analytics-revenue')!;
    const h = evaluationHarness(
      {
        generateStructured: (req) =>
          Promise.resolve(
            req.schemaName === 'admin_analytics_intent'
              ? { output: analyticsIntent() }
              : {
                  output: {
                    answer: candidate(req).output.answer.replace(
                      '300.000',
                      '900.000',
                    ),
                  },
                },
          ),
      },
      offlineConfig(),
    );
    await expect(entry.run(h)).rejects.toMatchObject({
      code: 'AI_INVALID_OUTPUT',
    });
    expect(h.audits[1]).toMatchObject({
      success: false,
      errorCode: 'AI_INVALID_OUTPUT',
    });
  });
});

describe('Synthetic expected/actual diagnostics', () => {
  const sanitize = diagnosticSanitizer({ GROQ_API_KEY: 'synthetic-secret' });
  it('keeps search keywords visible while scrubbing secret values and fields', () => {
    expect(
      sanitize({
        keywords: ['beef', 'synthetic-secret'],
        apiKey: 'hidden',
        systemPrompt: 'hidden',
        reasoning: 'hidden',
      }),
    ).toEqual({
      keywords: ['beef', '[REDACTED]'],
      apiKey: '[REDACTED]',
      systemPrompt: '[REDACTED]',
      reasoning: '[REDACTED]',
    });
  });
  it('prints the expected/actual layout with the real provider and sanitized assertion reason', () => {
    const diagnostic = caseDiagnostic(
      'search-budget',
      'groq',
      { maxPrice: 100000 },
      [
        { schemaName: 'menu_search_v1', input: { query: 'món dưới 100k' } },
        {
          schemaName: 'menu_search_v1',
          output: { maxPrice: 100000, keywords: [] },
        },
      ],
      [{ success: true } as AiAuditEntry],
      'GOLDEN_MISMATCH',
      'synthetic-secret unexpected category',
      sanitize,
    );
    expect(diagnostic).toMatchObject({
      serverValidation: 'PASS',
      goldenCheck: 'FAIL',
      failReason: '[REDACTED] unexpected category',
    });
    for (const label of [
      'CASE:',
      'INPUT:',
      'EXPECTED:',
      'ACTUAL GROQ STRUCTURED OUTPUT:',
      'SERVER VALIDATION:',
      'GOLDEN CHECK:',
      'FAIL REASON:',
    ])
      expect(diagnostic.formatted).toContain(label);
    expect(diagnostic.formatted).not.toContain('synthetic-secret');
  });
  it.each([
    'AI_PROVIDER_RATE_LIMIT',
    'AI_PROVIDER_UNAVAILABLE',
    'AI_TIMEOUT',
  ] as const)(
    'does not report a provider %s as a golden failure',
    (errorCode) => {
      const diagnostic = caseDiagnostic(
        'case',
        'groq',
        {},
        [],
        [{ success: false, errorCode } as AiAuditEntry],
        errorCode,
        'private exception',
        sanitize,
      );
      expect(diagnostic).toMatchObject({
        serverValidation: 'NOT VERIFIED',
        goldenCheck: 'NOT VERIFIED',
        failReason: errorCode,
      });
      expect(diagnostic.formatted).not.toContain('private exception');
    },
  );
  it('reports server validation failure separately from an unexecuted golden check', () => {
    expect(
      caseDiagnostic(
        'case',
        'openai',
        {},
        [],
        [{ success: false, errorCode: 'AI_INVALID_OUTPUT' } as AiAuditEntry],
        'AI_INVALID_OUTPUT',
        undefined,
        sanitize,
      ),
    ).toMatchObject({ serverValidation: 'FAIL', goldenCheck: 'NOT VERIFIED' });
  });
});
