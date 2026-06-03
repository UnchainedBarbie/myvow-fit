/**
 * FatSecret food search via the Cloudflare Worker.
 *
 * The Worker proxy stores the FatSecret consumer key/secret server-side; the app
 * only POSTs the user's query and never sees credentials. Network/parse failures
 * resolve to an empty array so curated + USDA results still surface.
 */

import type { FoodResult } from '../screens/AddFoodModal';

const FATSECRET_WORKER_URL =
  'https://myvow-fit-api.allison-spink.workers.dev/fatsecret/search';

const FATSECRET_MAX_RESULTS = 20;

type FatSecretRawFood = {
  food_id?: string | number;
  food_name?: string;
  brand_name?: string;
  food_description?: string;
  food_type?: string;
};

function numericFromLabel(text: string, label: string): number {
  const re = new RegExp(`${label}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'i');
  const m = re.exec(text);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses a FatSecret food_description like:
 *   "Per 1 large - Calories: 72kcal | Fat: 4.76g | Carbs: 0.36g | Protein: 6.28g"
 * Falls back to amount=1, unit="serving" when the "Per ... -" prefix is missing.
 */
function parseFatSecretDescription(desc: string): {
  amount: number;
  unitRaw: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
} {
  let amount = 1;
  let unitRaw = 'serving';
  const perMatch = /Per\s+([0-9]+(?:\.[0-9]+)?)\s*([^-|]*?)\s*(?:-|\|)/i.exec(desc);
  if (perMatch) {
    const a = parseFloat(perMatch[1]);
    if (Number.isFinite(a) && a > 0) amount = a;
    const u = perMatch[2].trim();
    if (u) unitRaw = u;
  }
  return {
    amount,
    unitRaw,
    calories: Math.round(numericFromLabel(desc, 'Calories')),
    protein: Math.round(numericFromLabel(desc, 'Protein') * 10) / 10,
    carbs: Math.round(numericFromLabel(desc, 'Carbs') * 10) / 10,
    fat: Math.round(numericFromLabel(desc, 'Fat') * 10) / 10,
  };
}

/** Mass/volume units we can convert to per-100g for unit-switching in the modal. */
function massUnitForFatSecret(unitRaw: string): 'g' | 'ml' | null {
  const u = unitRaw.trim().toLowerCase();
  if (u === 'g' || u === 'gram' || u === 'grams') return 'g';
  if (
    u === 'ml' ||
    u === 'milliliter' ||
    u === 'milliliters' ||
    u === 'millilitre' ||
    u === 'millilitres'
  ) {
    return 'ml';
  }
  return null;
}

function normalizeFatSecretFood(raw: FatSecretRawFood): FoodResult | null {
  const id = String(raw?.food_id ?? '').trim();
  const name = String(raw?.food_name ?? '').trim();
  if (!id || !name) return null;

  const brandRaw = String(raw?.brand_name ?? '').trim();
  const brand = brandRaw.length > 0 ? brandRaw : null;
  const desc = String(raw?.food_description ?? '');
  const parsed = parseFatSecretDescription(desc);

  const result: FoodResult = {
    code: `fatsecret_${id}`,
    food_name: name,
    brand,
    calories: parsed.calories,
    protein: parsed.protein,
    carbs: parsed.carbs,
    fat: parsed.fat,
    serving_size: `${parsed.amount} ${parsed.unitRaw}`.trim(),
    source: 'fatsecret',
    macrosArePerServing: true,
  };

  const unitMass = massUnitForFatSecret(parsed.unitRaw);
  if (unitMass && parsed.amount > 0) {
    const factor = 100 / parsed.amount;
    result.per100g = {
      calories: Math.round(parsed.calories * factor),
      protein: Math.round(parsed.protein * factor * 10) / 10,
      carbs: Math.round(parsed.carbs * factor * 10) / 10,
      fat: Math.round(parsed.fat * factor * 10) / 10,
    };
    result.defaultBarcodeMassUnit = unitMass;
  }

  return result;
}

/**
 * POST /fatsecret/search via the Worker. Always resolves; on any failure returns [].
 * `signal` is optional so the caller can share its AbortController with the parallel USDA fetch.
 */
export async function searchFatSecret(
  query: string,
  signal?: AbortSignal,
): Promise<FoodResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  let response: Response;
  try {
    response = await fetch(FATSECRET_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: trimmed, max_results: FATSECRET_MAX_RESULTS }),
      signal,
    });
  } catch (e) {
    console.error('[fatsecret] network error:', e);
    return [];
  }

  if (!response.ok) {
    console.error(
      '[fatsecret] non-200 response:',
      response.status,
      response.statusText,
    );
    return [];
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (e) {
    console.error('[fatsecret] invalid JSON:', e);
    return [];
  }

  const foodsContainer =
    (data as { foods?: { food?: unknown } } | null)?.foods ?? null;
  const rawFoods = foodsContainer?.food;
  const list: FatSecretRawFood[] = Array.isArray(rawFoods)
    ? (rawFoods as FatSecretRawFood[])
    : rawFoods != null && typeof rawFoods === 'object'
      ? [rawFoods as FatSecretRawFood]
      : [];

  if (list.length === 0) return [];

  const normalized: FoodResult[] = [];
  for (const raw of list) {
    const food = normalizeFatSecretFood(raw);
    if (food) normalized.push(food);
  }
  return normalized;
}
