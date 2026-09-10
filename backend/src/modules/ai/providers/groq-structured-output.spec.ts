import { groqResponseFormat } from './groq-structured-output';
import { dishDraftOutput } from '../catalog-draft/dish-draft-output';
import { ORDER_NOTE_OUTPUT } from '../order-note/order-note.dto';
import { MENU_SEARCH_OUTPUT } from '../menu-search/menu-search.dto';
import {
  analyticsAnswerOutput,
  analyticsIntentOutput,
} from '../admin-analytics/analytics.dto';
import {
  reviewClassificationOutput,
  reviewSummaryOutput,
} from '../review-intelligence/review-intelligence.dto';

describe('Groq schema compatibility preserves server contracts', () => {
  const model = 'openai/gpt-oss-20b';
  it.each([
    dishDraftOutput(['nameEn']),
    dishDraftOutput(['descriptionEn']),
    dishDraftOutput(['description']),
    dishDraftOutput(['nameEn', 'descriptionEn']),
    dishDraftOutput(['nameEn', 'description']),
    dishDraftOutput(['descriptionEn', 'description']),
    dishDraftOutput(['nameEn', 'descriptionEn', 'description']),
    ORDER_NOTE_OUTPUT,
    MENU_SEARCH_OUTPUT,
    analyticsIntentOutput,
    analyticsAnswerOutput(['Grounded answer']),
    reviewClassificationOutput,
    reviewSummaryOutput(['Grounded summary']),
  ])(
    'uses strict for $name while leaving the original server schema unchanged',
    ({ name, jsonSchema }) => {
      const before = JSON.stringify(jsonSchema);
      const format = groqResponseFormat(model, name, jsonSchema);
      expect(format.json_schema.strict).toBe(true);
      expect(JSON.stringify(jsonSchema)).toBe(before);
      if (
        jsonSchema !== ORDER_NOTE_OUTPUT.jsonSchema &&
        jsonSchema !== MENU_SEARCH_OUTPUT.jsonSchema
      )
        expect(format.json_schema.schema).toEqual(jsonSchema);
    },
  );
  it('omits only unsupported uniqueItems from provider arrays, preserving bounds and null unions', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['values', 'price'],
      properties: {
        values: {
          type: 'array',
          uniqueItems: true,
          maxItems: 12,
          items: { type: 'string', enum: ['uniqueItems', 'safe'] },
        },
        price: { type: ['integer', 'null'], minimum: 0, maximum: 100 },
      },
    };
    const normalized = groqResponseFormat(
      model,
      'normalized',
      schema,
    ).json_schema;
    expect(normalized.strict).toBe(true);
    expect(normalized.schema).toEqual({
      ...schema,
      properties: {
        ...schema.properties,
        values: {
          type: 'array',
          maxItems: 12,
          items: schema.properties.values.items,
        },
      },
    });
    expect(schema.properties.values.uniqueItems).toBe(true);
  });
  const property = { type: 'string' };
  it.each([
    {
      type: 'object',
      properties: { optional: property },
      required: [],
      additionalProperties: false,
    },
    { type: 'object', properties: { value: property }, required: ['value'] },
    {
      type: 'object',
      properties: { value: property },
      required: ['value', 'value'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { value: { $ref: '#/$defs/Value' } },
      required: ['value'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        value: {
          type: 'object',
          properties: { optional: property },
          additionalProperties: false,
        },
      },
      required: ['value'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { value: { type: 'array', items: { type: 'object' } } },
      required: ['value'],
      additionalProperties: false,
    },
  ])(
    'uses best-effort for incompatible schema without inventing required fields: %j',
    (schema) => {
      const before = JSON.stringify(schema);
      expect(groqResponseFormat(model, 'optional', schema).json_schema).toEqual(
        { name: 'optional', strict: false, schema },
      );
      expect(JSON.stringify(schema)).toBe(before);
    },
  );
  it('preserves required nullable fields, including anyOf', () => {
    const schema = {
      type: 'object',
      properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
      required: ['value'],
      additionalProperties: false,
    };
    expect(groqResponseFormat(model, 'nullable', schema).json_schema).toEqual({
      name: 'nullable',
      strict: true,
      schema,
    });
  });
  it('uses best-effort for models outside the known strict support list', () => {
    expect(
      groqResponseFormat(
        'openai/gpt-oss-safeguard-20b',
        ORDER_NOTE_OUTPUT.name,
        ORDER_NOTE_OUTPUT.jsonSchema,
      ).json_schema.strict,
    ).toBe(false);
  });
});
