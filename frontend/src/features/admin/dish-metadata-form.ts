import type { Dish } from '../../services/api/dish';

export interface DishMetadataForm {
  descriptionEn: string;
  ingredients: string[];
  allergenTags: string[];
  dietaryTags: string[];
  spiceLevel: string;
  servingSize: string;
  availableModifiers: string[];
}

export function metadataFromDish(dish?: Dish): DishMetadataForm {
  return {
    descriptionEn: dish?.descriptionEn ?? '',
    ingredients: dish?.ingredients ?? [],
    allergenTags: dish?.allergenTags ?? [],
    dietaryTags: dish?.dietaryTags ?? [],
    spiceLevel: dish?.spiceLevel == null ? '' : String(dish.spiceLevel),
    servingSize: dish?.servingSize ?? '',
    availableModifiers: dish?.availableModifiers ?? [],
  };
}

export function appendDishMetadata(form: FormData, metadata: DishMetadataForm) {
  form.append('descriptionEn', metadata.descriptionEn.trim());
  form.append('servingSize', metadata.servingSize.trim());
  form.append('spiceLevel', metadata.spiceLevel);
  for (const field of ['ingredients', 'allergenTags', 'dietaryTags', 'availableModifiers'] as const) {
    form.append(field, JSON.stringify(metadata[field].map((value) => value.trim())));
  }
}

