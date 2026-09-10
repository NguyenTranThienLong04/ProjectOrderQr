function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Conservative subset used by current domain schemas. Unknown schema constructs
// use best-effort without changing required/optional semantics.
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
  'title',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'anyOf',
]);

function normalizeSchema(schema: unknown): unknown {
  if (!record(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      // Live Groq rejects uniqueItems even in an otherwise strict-compatible schema.
      // ArrayUnique stays on the original server DTO; never normalize the response.
      .filter(([key]) => !(key === 'uniqueItems' && schema.type === 'array'))
      .map(([key, value]) => {
        if (key === 'properties' && record(value))
          return [
            key,
            Object.fromEntries(
              Object.entries(value).map(([name, child]) => [
                name,
                normalizeSchema(child),
              ]),
            ),
          ];
        if (key === 'items') return [key, normalizeSchema(value)];
        if (key === 'anyOf' && Array.isArray(value))
          return [key, value.map(normalizeSchema)];
        return [key, value];
      }),
  );
}
function strictSchema(schema: unknown): boolean {
  if (!record(schema) || Object.keys(schema).some((key) => !keywords.has(key)))
    return false;
  if (schema.anyOf !== undefined) {
    if (
      !Array.isArray(schema.anyOf) ||
      !schema.anyOf.length ||
      !schema.anyOf.every(strictSchema)
    )
      return false;
  }
  const types: unknown[] = Array.isArray(schema.type)
    ? schema.type
    : [schema.type];
  if (
    !types.every((type) =>
      [
        'object',
        'array',
        'string',
        'number',
        'integer',
        'boolean',
        'null',
      ].includes(String(type)),
    )
  )
    return schema.type === undefined && Array.isArray(schema.anyOf);
  if (types.includes('object')) {
    if (
      !record(schema.properties) ||
      schema.additionalProperties !== false ||
      !Array.isArray(schema.required)
    )
      return false;
    const keys = Object.keys(schema.properties);
    if (
      schema.required.length !== keys.length ||
      new Set(schema.required).size !== keys.length ||
      !keys.every((key) => (schema.required as unknown[]).includes(key))
    )
      return false;
    if (!Object.values(schema.properties).every(strictSchema)) return false;
  } else if (schema.properties !== undefined) return false;
  if (types.includes('array') && !strictSchema(schema.items)) return false;
  return true;
}

export function groqResponseFormat(
  model: string,
  name: string,
  schema: Readonly<Record<string, unknown>>,
) {
  const providerSchema = normalizeSchema(schema) as Record<string, unknown>;
  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict:
        [
          'openai/gpt-oss-20b',
          'openai/gpt-oss-120b',
          'qwen/qwen3.8-27b',
        ].includes(model) &&
        schema.type === 'object' &&
        strictSchema(providerSchema),
      schema: providerSchema,
    },
  };
}
