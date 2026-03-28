/**
 * Dynamic unit lists for food logging (Add Food modal, Nutrition quantity flow).
 * Keyword matching mirrors generateMealPlanGroceryAndPrep: delimiter-aware single words,
 * substring for multi-word phrases.
 */

function sortKeywordsLongestFirst(keywords: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keywords) {
    const t = k.toLowerCase().trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

export function matchesKeyword(haystackLower: string, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  if (kw.includes(' ')) {
    return haystackLower.includes(kw);
  }
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(haystackLower);
}

function matchesAny(haystackLower: string, keywords: readonly string[]): boolean {
  return keywords.some((k) => matchesKeyword(haystackLower, k));
}

/** Cheese first so “cream cheese” is not classified as liquid “cream”. */
const CHEESE_KEYWORDS = sortKeywordsLongestFirst([
  'cream cheese',
  'cottage cheese',
  'string cheese',
  'goat cheese',
  'mascarpone',
  'mozzarella',
  'cheddar',
  'feta',
  'parmesan',
  'ricotta',
  'gouda',
  'brie',
  'halloumi',
  'provolone',
  'swiss cheese',
  'blue cheese',
  'cheese',
]);

const NUTS_SEEDS_KEYWORDS = sortKeywordsLongestFirst([
  'almond butter',
  'peanut butter',
  'sunflower seeds',
  'pumpkin seeds',
  'chia seeds',
  'flax seeds',
  'hemp seeds',
  'mixed nuts',
  'pine nuts',
  'macadamia',
  'pistachio',
  'cashew',
  'walnut',
  'pecan',
  'hazelnut',
  'almond',
  'peanut',
  'brazil nut',
  'sesame seeds',
  'sunflower seed',
  'nuts',
  'seeds',
  'seed',
]);

const LIQUIDS_KEYWORDS = sortKeywordsLongestFirst([
  'coconut milk',
  'almond milk',
  'soy milk',
  'oat milk',
  'rice milk',
  'cashew milk',
  'heavy cream',
  'whipping cream',
  'half and half',
  'coffee creamer',
  'vegetable oil',
  'olive oil',
  'coconut oil',
  'sesame oil',
  'fish sauce',
  'soy sauce',
  'hot sauce',
  'worcestershire',
  'chicken broth',
  'beef broth',
  'vegetable broth',
  'bone broth',
  'smoothie',
  'shake',
  'protein shake',
  'juice',
  'coffee',
  'espresso',
  'latte',
  'tea',
  'kombucha',
  'soda',
  'water',
  'broth',
  'stock',
  'milk',
  'oil',
  'cream',
  'beverage',
  'wine',
  'beer',
  'liquor',
]);

const LEAFY_KEYWORDS = sortKeywordsLongestFirst([
  'mixed greens',
  'spring mix',
  'baby spinach',
  'collard greens',
  'mustard greens',
  'turnip greens',
  'beet greens',
  'watercress',
  'spinach',
  'arugula',
  'lettuce',
  'romaine',
  'iceberg',
  'kale',
  'chard',
  'greens',
  'cilantro',
  'parsley',
  'basil',
  'mint',
  'dill',
  'thyme',
  'rosemary',
  'oregano',
  'sage',
  'herbs',
  'herb',
]);

const WHOLE_PRODUCE_KEYWORDS = sortKeywordsLongestFirst([
  'bell pepper',
  'sweet pepper',
  'chili pepper',
  'jalapeño',
  'jalapeno',
  'avocado',
  'banana',
  'plantain',
  'egg',
  'eggs',
  'apple',
  'orange',
  'lemon',
  'lime',
  'grapefruit',
  'potato',
  'sweet potato',
  'onion',
  'shallot',
  'garlic',
  'tomato',
  'cucumber',
  'zucchini',
  'pear',
  'peach',
  'plum',
  'mango',
]);

const MEAT_FISH_KEYWORDS = sortKeywordsLongestFirst([
  'chicken breast',
  'chicken thigh',
  'chicken wing',
  'ground beef',
  'ground turkey',
  'ground pork',
  'salmon fillet',
  'fish fillet',
  'deli meat',
  'chicken',
  'turkey',
  'beef',
  'pork',
  'lamb',
  'duck',
  'veal',
  'bison',
  'salmon',
  'tuna',
  'cod',
  'tilapia',
  'halibut',
  'mackerel',
  'sardine',
  'shrimp',
  'prawn',
  'scallop',
  'crab',
  'lobster',
  'fish',
  'seafood',
  'steak',
  'chop',
  'bacon',
  'sausage',
  'ham',
  'prosciutto',
]);

const GRAINS_POWDERS_KEYWORDS = sortKeywordsLongestFirst([
  'protein powder',
  'baking powder',
  'baking soda',
  'cocoa powder',
  'coconut flour',
  'almond flour',
  'wheat flour',
  'all purpose flour',
  'bread flour',
  'cake flour',
  'brown rice',
  'white rice',
  'wild rice',
  'jasmine rice',
  'basmati rice',
  'rice',
  'pasta',
  'spaghetti',
  'noodle',
  'oats',
  'oatmeal',
  'quinoa',
  'barley',
  'bulgur',
  'couscous',
  'cereal',
  'flour',
  'cornmeal',
  'polenta',
  'granola',
  'sugar',
  'powder',
]);

const DEFAULT_UNITS = ['serving', 'g', 'oz', 'cup', 'tbsp', 'tsp', 'ml'] as const;

const LIQUIDS_UNITS = ['ml', 'fl oz', 'cup', 'tbsp', 'tsp', 'serving'] as const;
const WHOLE_UNITS = ['whole', 'medium', 'large', 'small', 'serving', 'g', 'oz'] as const;
const LEAFY_UNITS = ['cup', 'g', 'oz', 'serving'] as const;
const MEAT_UNITS = ['oz', 'g', 'lb', 'serving'] as const;
const GRAINS_UNITS = ['g', 'oz', 'cup', 'tbsp', 'tsp', 'serving'] as const;
const CHEESE_UNITS = ['oz', 'g', 'slice', 'cup', 'serving'] as const;
const NUTS_UNITS = ['g', 'oz', 'cup', 'tbsp', 'tsp', 'serving'] as const;

function dedupeWithServingFirst(list: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of list) {
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  if (!seen.has('serving')) {
    out.push('serving');
  }
  return out;
}

/**
 * Ordered relevant units for a food. Always includes `serving` at least once.
 */
export function getRelevantUnits(foodName: string, servingSize?: string | null): string[] {
  const hay = `${String(foodName ?? '')} ${String(servingSize ?? '')}`.toLowerCase();

  if (matchesAny(hay, CHEESE_KEYWORDS)) {
    return dedupeWithServingFirst([...CHEESE_UNITS]);
  }
  if (matchesAny(hay, NUTS_SEEDS_KEYWORDS)) {
    return dedupeWithServingFirst([...NUTS_UNITS]);
  }
  if (matchesAny(hay, LIQUIDS_KEYWORDS)) {
    return dedupeWithServingFirst([...LIQUIDS_UNITS]);
  }
  if (matchesAny(hay, LEAFY_KEYWORDS)) {
    return dedupeWithServingFirst([...LEAFY_UNITS]);
  }
  if (matchesAny(hay, WHOLE_PRODUCE_KEYWORDS)) {
    return dedupeWithServingFirst([...WHOLE_UNITS]);
  }
  if (matchesAny(hay, MEAT_FISH_KEYWORDS)) {
    return dedupeWithServingFirst([...MEAT_UNITS]);
  }
  if (matchesAny(hay, GRAINS_POWDERS_KEYWORDS)) {
    return dedupeWithServingFirst([...GRAINS_UNITS]);
  }
  return dedupeWithServingFirst([...DEFAULT_UNITS]);
}

/**
 * Map a serving_size string to a unit token if recognizable (e.g. "6 oz" → "oz", "30 ml" → "ml").
 */
export function parseUnitTokenFromServingSize(servingSize?: string | null): string | null {
  if (servingSize == null || !String(servingSize).trim()) return null;
  const s = String(servingSize).trim().toLowerCase();

  if (/\b(fl\.?\s*oz|fluid\s*oz|fluid\s*ounce)\b/i.test(s)) return 'fl oz';
  if (/\b(ml|milliliter|millilitre|milliliters)\b/i.test(s)) return 'ml';
  if (/\b(cl|centiliter)\b/i.test(s)) return 'ml';
  if (/\b(l|liter|litre|liters|litres)\b(?![a-z])/i.test(s)) return 'ml';
  if (/\b(tbsp|tablespoon|tablespoons)\b/i.test(s)) return 'tbsp';
  if (/\b(tsp|teaspoon|teaspoons)\b/i.test(s)) return 'tsp';
  if (/\bcup\b|\bcups\b/i.test(s)) return 'cup';
  if (/\b(lb|lbs|pound|pounds)\b/i.test(s)) return 'lb';
  if (/\b(g|gram|grams)\b/i.test(s)) return 'g';
  if (/\b(oz|ounce|ounces)\b/i.test(s)) return 'oz';
  if (/\bslice\b|\bslices\b/i.test(s)) return 'slice';
  if (/\bwhole\b/i.test(s)) return 'whole';
  if (/\bmedium\b/i.test(s)) return 'medium';
  if (/\blarge\b/i.test(s)) return 'large';
  if (/\bsmall\b/i.test(s)) return 'small';
  if (/\bserving\b|\bservings\b/i.test(s)) return 'serving';

  return null;
}

function canonicalUnitInList(parsed: string, list: readonly string[]): string | null {
  const p = parsed.toLowerCase();
  const hit = list.find((u) => u.toLowerCase() === p);
  return hit ?? null;
}

/**
 * Prefer unit parsed from `servingSize` if it appears in `getRelevantUnits`, else `fallbackUnit` if listed, else first list entry.
 */
/**
 * Count/size units: macro math treats each as one logical serving (per-serving × quantity),
 * not a mass conversion.
 */
export function isPieceServingUnit(unit: string): boolean {
  const u = String(unit ?? '').trim().toLowerCase();
  return u === 'whole' || u === 'medium' || u === 'large' || u === 'small';
}

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
