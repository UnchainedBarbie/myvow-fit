/**
 * Food logging quantity units (Add Food modal, Nutrition).
 * Only standard mass/volume + serving — no slice/whole/piece/count tokens in the UI list.
 */

/** Single canonical list for all food sources (USDA, barcode, favorites, manual). */
export const STANDARD_FOOD_QUANTITY_UNITS: readonly string[] = [
  'serving',
  'g',
  'oz',
  'ml',
  'cup',
  'tbsp',
  'tsp',
];

/**
 * Relevant units for quantity pickers. `foodName` / `servingSize` are ignored so options stay standard.
 */
export function getRelevantUnits(_foodName: string, _servingSize?: string | null): string[] {
  return [...STANDARD_FOOD_QUANTITY_UNITS];
}

/**
 * If text includes both "whole" and a size (medium/large/small), use only the size as the unit label
 * (e.g. "whole medium" → "medium"). Otherwise returns `text` unchanged (trimmed).
 * Used for stored/display tokens (e.g. meal plan → tracker), not for this unit dropdown list.
 */
export function preferSizeUnitOverWholeServingText(text: string): string {
  const raw = String(text ?? '').trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  if (!/\bwhole\b/i.test(lower)) return raw;
  if (/\bmedium\b/i.test(lower)) return 'medium';
  if (/\blarge\b/i.test(lower)) return 'large';
  if (/\bsmall\b/i.test(lower)) return 'small';
  return raw;
}

/**
 * Map a serving_size string to a unit token only when it matches a standard picker unit
 * (e.g. "6 oz" → "oz", "30 ml" → "ml"). Does not infer slice/whole/piece/medium/large/small or lb/fl oz.
 */
export function parseUnitTokenFromServingSize(servingSize?: string | null): string | null {
  if (servingSize == null || !String(servingSize).trim()) return null;
  const s = String(servingSize).trim().toLowerCase();

  if (/\b(ml|milliliter|millilitre|milliliters)\b/i.test(s)) return 'ml';
  if (/\b(cl|centiliter)\b/i.test(s)) return 'ml';
  if (/\b(l|liter|litre|liters|litres)\b(?![a-z])/i.test(s)) return 'ml';
  if (/\b(tbsp|tablespoon|tablespoons)\b/i.test(s)) return 'tbsp';
  if (/\b(tsp|teaspoon|teaspoons)\b/i.test(s)) return 'tsp';
  if (/\bcup\b|\bcups\b/i.test(s)) return 'cup';
  if (/\b(g|gram|grams)\b/i.test(s)) return 'g';
  if (/\b(oz|ounce|ounces)\b/i.test(s)) return 'oz';
  if (/\bserving\b|\bservings\b/i.test(s)) return 'serving';

  return null;
}

function canonicalUnitInList(parsed: string, list: readonly string[]): string | null {
  const p = parsed.toLowerCase();
  const hit = list.find((u) => u.toLowerCase() === p);
  return hit ?? null;
}

/**
 * Count/size units: macro math treats each as one logical serving (per-serving × quantity),
 * not a mass conversion. Still used for legacy rows / meal-plan tokens.
 */
export function isPieceServingUnit(unit: string): boolean {
  const u = String(unit ?? '').trim().toLowerCase();
  return u === 'whole' || u === 'medium' || u === 'large' || u === 'small';
}

/**
 * Prefer unit parsed from `servingSize` if it appears in `getRelevantUnits`, else `fallbackUnit` if listed, else `serving`.
 */
export function pickDefaultUnitForFood(
  foodName: string,
  servingSize: string | null | undefined,
  fallbackUnit: string,
): string {
  const list = getRelevantUnits(foodName, servingSize);
  const parsed = parseUnitTokenFromServingSize(servingSize);
  if (parsed) {
    const c = canonicalUnitInList(parsed, list);
    if (c) return c;
  }
  const fb = canonicalUnitInList(fallbackUnit, list);
  if (fb) return fb;
  const servingHit = list.find((u) => u.toLowerCase() === 'serving');
  return servingHit ?? list[0] ?? 'serving';
}
