import { IsString, Matches, MaxLength } from 'class-validator';
import type { AiOutputSchema } from '../ai.types';
import {
  DISH_DRAFT_FIELDS,
  DISH_DRAFT_LIMITS,
  type DishDraftField,
  type DishDraftResult,
} from './dish-draft.dto';

// Seven bounded subsets, each with its own DTO whitelist. Extra/unrequested
// fields fail inside the orchestrator so the failure is audited correctly.
const schemas = new Map<string, AiOutputSchema<DishDraftResult>>();
export function dishDraftOutput(
  fields: DishDraftField[],
): AiOutputSchema<DishDraftResult> {
  const selected = DISH_DRAFT_FIELDS.filter((field) => fields.includes(field));
  const key = selected.join('_');
  const existing = schemas.get(key);
  if (existing) return existing;
  class SelectedDishDraft {}
  const properties: Record<string, unknown> = {};
  for (const field of selected) {
    IsString()(SelectedDishDraft.prototype, field);
    Matches(/\S/u)(SelectedDishDraft.prototype, field);
    MaxLength(DISH_DRAFT_LIMITS[field])(SelectedDishDraft.prototype, field);
    properties[field] = {
      type: 'string',
      pattern: '\\S',
      maxLength: DISH_DRAFT_LIMITS[field],
    };
  }
  const schema: AiOutputSchema<DishDraftResult> = {
    name: `dish_draft_${key}`,
    dto: SelectedDishDraft,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      properties,
      required: selected,
    },
  };
  schemas.set(key, schema);
  return schema;
}
