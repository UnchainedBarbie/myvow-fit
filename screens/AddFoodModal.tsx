/**
 * Add Food modal: Search (USDA FoodData Central) + Favorites.
 * Barcode uses Open Food Facts. Title and content respect safe area.
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { initNutritionDb } from '../utils/nutritionDb';
import { searchFatSecret } from '../services/fatsecret';
import {
  getRelevantUnits,
  pickDefaultUnitForFood,
  isPieceServingUnit,
} from '../utils/getRelevantUnits';

const SAGE = '#7C9A7E';

const NO_RESULTS_MESSAGE =
  'No results found. Try a different search or scan the barcode.';

const FOOD_SEARCH_TIMEOUT_MS = 15000;
const SEARCH_SLOW_OR_UNAVAILABLE_MESSAGE =
  'Search is taking too long — try a more specific search term or scan the barcode.';

const MEAL_OPTIONS = ['Breakfast', 'Snack', 'Lunch', 'Dinner'] as const;

/** Grams per unit (for volume we approximate as weight). */
function gramsPerUnit(unit: string): number {
  switch (unit) {
    case 'g': return 1;
    case 'oz': return 28.3495;
    case 'fl oz': return 29.5735;
    case 'serving': return 100;
    case 'cup': return 240;
    case 'tbsp': return 15;
    case 'tsp': return 5;
    case 'ml': return 1;
    case 'lb': return 453.59;
    case 'slice': return 28;
    default: return 100;
  }
}

/** Given per-100g values, compute total macros for quantity + unit. */
function computedMacros(
  per100: { calories: number; protein: number; carbs: number; fat: number },
  quantity: number,
  unit: string
): { calories: number; protein: number; carbs: number; fat: number } {
  const grams = quantity * gramsPerUnit(unit);
  const factor = grams / 100;
  return {
    calories: Math.round(per100.calories * factor),
    protein: Math.round(per100.protein * factor * 10) / 10,
    carbs: Math.round(per100.carbs * factor * 10) / 10,
    fat: Math.round(per100.fat * factor * 10) / 10,
  };
}

export type FoodResult = {
  code: string;
  food_name: string;
  brand: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  serving_size?: string | null;
  source?: 'off' | 'usda' | 'curated' | 'fatsecret';
  /** Barcode + OFF: calories/macros are for one API serving (not per 100g). */
  macrosArePerServing?: boolean;
  /** Per-100g nutriments when present (barcode: used if user switches unit off “serving”). */
  per100g?: { calories: number; protein: number; carbs: number; fat: number };
  /** Barcode, per-100g-only path: default unit when quantity defaults to 100. */
  defaultBarcodeMassUnit?: 'g' | 'ml';
  /** USDA FDC: declared serving amount from API (household serving). */
  usdaServingSizeAmount?: number;
  /** USDA FDC: declared serving unit string from API. */
  usdaServingSizeUnit?: string | null;
  /** Grams for the full declared API serving when mass-convertible. */
  usdaDeclaredServingGrams?: number | null;
};

/** Favorite from DB (same table as Profile uses). */
export type FavoriteFoodItem = {
  favorite_id: number;
  food_name: string;
  brand: string | null;
  serving_size?: string | null;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
};

function favoriteSignature(name: string, brand: string | null): string {
  return `${name}|${brand ?? ''}`;
}

/** Map API / UI unit strings to canonical keys for gram math. */
function normalizeUnitKeyForGrams(u: string): string {
  const x = String(u).trim().toLowerCase();
  if (!x) return '';
  if (x === 'g' || x === 'gram' || x === 'grams') return 'g';
  if (
    x === 'ml' ||
    x === 'milliliter' ||
    x === 'milliliters' ||
    x === 'millilitre'
  ) {
    return 'ml';
  }
  if (x === 'oz' || x === 'ounce' || x === 'ounces') return 'oz';
  if (x === 'cup' || x === 'cups') return 'cup';
  if (x === 'tbsp' || x === 'tablespoon' || x === 'tablespoons' || x === 'tbs') {
    return 'tbsp';
  }
  if (x === 'tsp' || x === 'teaspoon' || x === 'teaspoons') return 'tsp';
  if (x === 'slice' || x === 'slices' || x === 'piece' || x === 'pieces') {
    return 'slice';
  }
  if (x === 'serving' || x === 'servings') return 'serving';
  if (
    x === 'fl oz' ||
    x === 'floz' ||
    x === 'fluid ounce' ||
    x === 'fluid ounces'
  ) {
    return 'fl oz';
  }
  if (x === 'lb' || x === 'lbs' || x === 'pound' || x === 'pounds') return 'lb';
  return x;
}

/** Canonical unit for quantity UI + totalGramsForUsdaPer100Food from USDA search servingSizeUnit. */
function usdaApiServingUnitToUiUnit(unitRaw: string): string {
  return normalizeUnitKeyForGrams(unitRaw) || 'serving';
}

function usdaServingAmountToQtyString(amt: number): string {
  if (!Number.isFinite(amt) || amt <= 0) return '1';
  if (Number.isInteger(amt)) return String(amt);
  const s = parseFloat(amt.toFixed(4)).toString();
  return s || String(amt);
}

/**
 * Convert USDA declared household serving to total grams when the API unit is mass/volume.
 */
function convertUsdaDeclaredPortionToGrams(amount: number, unitRaw: string): number | null {
  if (!(amount > 0)) return null;
  const k = normalizeUnitKeyForGrams(unitRaw);
  switch (k) {
    case 'g':
    case 'ml':
      return amount;
    case 'oz':
      return amount * 28.3495;
    case 'cup':
      return amount * 240;
    case 'tbsp':
      return amount * 15;
    case 'tsp':
      return amount * 5;
    case 'lb':
      return amount * 453.59;
    case 'fl oz':
      return amount * 29.5735;
    default:
      return null;
  }
}

function isUsdaSearchPer100Food(food: FoodResult | FavoriteFoodItem): food is FoodResult {
  return (
    typeof food === 'object' &&
    food != null &&
    'source' in food &&
    food.source === 'usda' &&
    !!food.per100g
  );
}

/**
 * Total grams of food for per-100g macro scaling (USDA search only).
 * g/ml: quantity = grams/ml; oz: ×28.3495; serving: × API declared grams or 100g default.
 */
function totalGramsForUsdaPer100Food(food: FoodResult, quantity: number, unit: string): number {
  const q = quantity > 0 ? quantity : 0;
  const u = normalizeUnitKeyForGrams(unit);
  const apiAmt = food.usdaServingSizeAmount;
  const apiUnitNorm = normalizeUnitKeyForGrams(food.usdaServingSizeUnit ?? '');
  const apiG = food.usdaDeclaredServingGrams;

  if (u === 'g' || u === 'ml') return q;
  if (u === 'oz') return q * 28.3495;

  if (u === 'serving') {
    return q * (apiG != null && apiG > 0 ? apiG : 100);
  }

  if (u === 'cup' || u === 'tbsp' || u === 'tsp') {
    if (
      apiG != null &&
      apiG > 0 &&
      apiAmt != null &&
      apiAmt > 0 &&
      apiUnitNorm === u
    ) {
      return q * (apiG / apiAmt);
    }
    return q * gramsPerUnit(u);
  }

  if (u === 'slice' || isPieceServingUnit(unit)) {
    if (
      apiG != null &&
      apiG > 0 &&
      apiAmt != null &&
      apiAmt > 0 &&
      (apiUnitNorm === 'slice' || apiUnitNorm === 'serving')
    ) {
      return q * (apiG / apiAmt);
    }
    return q * gramsPerUnit('slice');
  }

  if (u === 'fl oz') return q * 29.5735;
  if (u === 'lb') return q * 453.59;

  return q * gramsPerUnit(unit);
}

export type AddFoodModalProps = {
  visible: boolean;
  mealType: string;
  selectedDate: string;
  onClose: () => void;
  onFoodAdded?: () => void;
  /** When set, choosing a food updates this log row instead of inserting a new one. */
  replaceLoggedFoodId?: number | null;
  /** Overrides header title (default: "Add Food", or "Change food" when replacing). */
  headerTitle?: string;
};

function numNut(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function extractPer100gFromNutriments(nut: Record<string, unknown>): {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
} {
  const kcal = numNut(nut['energy-kcal_100g'] ?? nut.energy_100g);
  return {
    calories: Math.round(kcal),
    protein: Math.round(numNut(nut.proteins_100g) * 10) / 10,
    carbs: Math.round(numNut(nut.carbohydrates_100g) * 10) / 10,
    fat: Math.round(numNut(nut.fat_100g) * 10) / 10,
  };
}

function extractPerServingFromNutriments(nut: Record<string, unknown>): {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
} {
  const kj = numNut(nut['energy-kj_serving']);
  const kcal =
    numNut(nut['energy-kcal_serving']) ||
    (kj > 0 ? kj / 4.184 : 0) ||
    numNut(nut.energy_serving);
  return {
    kcal,
    protein: numNut(nut.proteins_serving),
    carbs: numNut(nut.carbohydrates_serving),
    fat: numNut(nut.fat_serving),
  };
}

function servingNutrientsMeaningful(s: ReturnType<typeof extractPerServingFromNutriments>): boolean {
  return s.kcal > 0 || s.protein > 0 || s.carbs > 0 || s.fat > 0;
}

function productHasServingSizeDefined(p: { serving_size?: unknown; serving_quantity?: unknown }): boolean {
  if (String(p.serving_size ?? '').trim()) return true;
  const sq = p.serving_quantity;
  if (sq == null || sq === '') return false;
  const n = Number(sq);
  return Number.isFinite(n) && n > 0;
}

/** Default mass unit for barcode products that only have per-100g data. */
function inferDefaultMassUnitForBarcode(p: {
  serving_size?: unknown;
  nutrition_data_per?: unknown;
  categories_tags?: unknown;
}): 'g' | 'ml' {
  const ss = String(p.serving_size ?? '').toLowerCase();
  if (/\bml\b|\bcl\b/.test(ss)) return 'ml';
  const ndp = String(p.nutrition_data_per ?? '').toLowerCase();
  if (ndp.includes('ml')) return 'ml';
  const tags = Array.isArray(p.categories_tags)
    ? p.categories_tags.join(' ').toLowerCase()
    : '';
  if (
    /en:beverages|en:waters|en:soft-drinks|en:alcoholic-beverages|en:beers|en:wines|en:plant-milks|en:dairy-drinks|en:juices/.test(
      tags,
    )
  ) {
    return 'ml';
  }
  return 'g';
}

type CommonFoodRow = {
  id: number;
  name: string;
  search_terms: string;
  serving_size: number;
  serving_unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

/**
 * Curated CommonFoods row → FoodResult.
 * Per-serving macros are stored on the row; per100g is derived so unit switches (g/ml) still scale correctly.
 */
function normalizeCommonFood(row: CommonFoodRow): FoodResult {
  const servingSize = row.serving_size > 0 ? row.serving_size : 1;
  const factor = 100 / servingSize;
  const per100g = {
    calories: Math.round(row.calories * factor),
    protein: Math.round(row.protein_g * factor * 10) / 10,
    carbs: Math.round(row.carbs_g * factor * 10) / 10,
    fat: Math.round(row.fat_g * factor * 10) / 10,
  };
  const massUnit: 'g' | 'ml' =
    String(row.serving_unit).trim().toLowerCase() === 'ml' ? 'ml' : 'g';
  return {
    code: `curated_${row.id}`,
    food_name: row.name,
    brand: null,
    calories: Math.round(row.calories),
    protein: Math.round(row.protein_g * 10) / 10,
    carbs: Math.round(row.carbs_g * 10) / 10,
    fat: Math.round(row.fat_g * 10) / 10,
    serving_size: `${row.serving_size} ${row.serving_unit}`,
    source: 'curated',
    macrosArePerServing: true,
    per100g,
    defaultBarcodeMassUnit: massUnit,
  };
}

/** USDA FoodData Central nutrient ids (search response). */
const USDA_NUTRIENT_ENERGY_KCAL = 1008;
const USDA_NUTRIENT_PROTEIN = 1003;
const USDA_NUTRIENT_CARBS = 1005;
const USDA_NUTRIENT_FAT = 1004;

function usdaNutrientValue(
  foodNutrients: unknown,
  nutrientId: number,
): number {
  if (!Array.isArray(foodNutrients)) return 0;
  for (const n of foodNutrients) {
    if (!n || typeof n !== 'object') continue;
    const row = n as Record<string, unknown>;
    const id = Number(row.nutrientId ?? (row.nutrient as Record<string, unknown> | undefined)?.id);
    if (id === nutrientId) {
      return numNut(row.value ?? row.amount);
    }
  }
  return 0;
}

function usdaEnergyKcalFromNutrients(foodNutrients: unknown): number {
  let kcal = usdaNutrientValue(foodNutrients, USDA_NUTRIENT_ENERGY_KCAL);
  if (kcal > 0) return kcal;
  if (!Array.isArray(foodNutrients)) return 0;
  for (const n of foodNutrients) {
    if (!n || typeof n !== 'object') continue;
    const row = n as Record<string, unknown>;
    const name = String(
      row.nutrientName ?? (row.nutrient as Record<string, unknown> | undefined)?.name ?? '',
    ).toLowerCase();
    const unit = String(
      row.unitName ?? (row.nutrient as Record<string, unknown> | undefined)?.unitName ?? '',
    ).toUpperCase();
    if (name === 'energy' && unit === 'KJ') {
      return Math.round(numNut(row.value ?? row.amount) / 4.184);
    }
  }
  return 0;
}

function formatUsdaServingSize(food: Record<string, unknown>): string | null {
  const size = food.servingSize;
  const unitRaw = food.servingSizeUnit;
  if (size == null || size === '') return null;
  const unit = String(unitRaw ?? '').trim();
  if (!unit) return String(size).trim();
  return `${String(size).trim()} ${unit}`.trim();
}

/** SR Legacy search hits often lack servingSize; use 100g equivalent with g or ml default. */
function inferUsdaSrDefaultMassUnit(food: Record<string, unknown>): 'g' | 'ml' {
  const cat = String(food.foodCategory || '').toLowerCase();
  if (
    /beverage|beverages|juice|drinks|soda|water|coffee|tea|wine|beer|alcoholic/.test(
      cat,
    )
  ) {
    return 'ml';
  }
  return 'g';
}

/**
 * Map USDA `/foods/search` item to FoodResult.
 * Nutrients from search are treated as per 100g; declared servingSize/servingSizeUnit scale cup/tbsp/tsp/serving/slice.
 */
function normalizeUsdaSearchFood(food: Record<string, unknown>): FoodResult | null {
  const fdcId = food.fdcId;
  if (fdcId == null) return null;

  const nutrients = food.foodNutrients;
  const calories = usdaEnergyKcalFromNutrients(nutrients);
  const protein = usdaNutrientValue(nutrients, USDA_NUTRIENT_PROTEIN);
  const carbs = usdaNutrientValue(nutrients, USDA_NUTRIENT_CARBS);
  const fat = usdaNutrientValue(nutrients, USDA_NUTRIENT_FAT);

  const description = String(food.description || '').trim() || 'Unknown';
  const owner = String(food.brandOwner || '').trim();
  const bname = String(food.brandName || '').trim();
  const brand = owner || bname || null;

  const servingSizeNum = numNut(food.servingSize);
  const unitStr = String(food.servingSizeUnit || '').trim();
  const hasServing = servingSizeNum > 0 && unitStr.length > 0;
  const serving_size = formatUsdaServingSize(food);

  const per100g = {
    calories: Math.round(calories),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
  };

  const usdaDeclaredServingGrams = hasServing
    ? convertUsdaDeclaredPortionToGrams(servingSizeNum, unitStr)
    : null;

  return {
    code: String(fdcId),
    food_name: description,
    brand,
    calories: per100g.calories,
    protein: per100g.protein,
    carbs: per100g.carbs,
    fat: per100g.fat,
    serving_size,
    source: 'usda',
    macrosArePerServing: false,
    per100g,
    defaultBarcodeMassUnit: inferUsdaSrDefaultMassUnit(food),
    ...(hasServing
      ? {
          usdaServingSizeAmount: servingSizeNum,
          usdaServingSizeUnit: unitStr,
          usdaDeclaredServingGrams,
        }
      : {}),
  };
}

/**
 * Barcode / full product JSON: prefer per-serving nutriments as returned by OFF.
 * If there are no serving-level nutrients, use per-100g only and default UI to 100 g or 100 ml.
 */
function normalizeOffProductFromBarcode(p: any): FoodResult {
  const nut = (p.nutriments || {}) as Record<string, unknown>;
  const per100 = extractPer100gFromNutriments(nut);
  const perSrv = extractPerServingFromNutriments(nut);
  const hasServingSize = productHasServingSizeDefined(p);
  const hasServingN = servingNutrientsMeaningful(perSrv);

  const base: FoodResult = {
    code: String(p.code || ''),
    food_name: p.product_name || p.food_name || 'Unknown',
    brand: p.brands || p.brand || null,
    serving_size: p.serving_size || null,
    source: 'off',
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
  };

  if (hasServingN) {
    return {
      ...base,
      calories: Math.round(perSrv.kcal),
      protein: Math.round(perSrv.protein * 10) / 10,
      carbs: Math.round(perSrv.carbs * 10) / 10,
      fat: Math.round(perSrv.fat * 10) / 10,
      macrosArePerServing: true,
      per100g:
        per100.calories > 0 || per100.protein > 0 || per100.carbs > 0 || per100.fat > 0
          ? per100
          : undefined,
    };
  }

  return {
    ...base,
    calories: per100.calories,
    protein: per100.protein,
    carbs: per100.carbs,
    fat: per100.fat,
    macrosArePerServing: false,
    per100g: per100,
    defaultBarcodeMassUnit: !hasServingSize
      ? inferDefaultMassUnitForBarcode(p)
      : undefined,
  };
}

/** Non-empty package serving description (e.g. "6 oz", "1 cup"). */
function trimmedServingSize(food: { serving_size?: string | null }): string {
  return String(food.serving_size ?? '').trim();
}

/**
 * Use quantity=1, unit=serving, and store base `serving_size` on save.
 * Search/barcode: per-serving macros from API. Favorites: macros are per saved serving when `serving_size` is set.
 */
function useServingPortionDefaults(food: FoodResult | FavoriteFoodItem): boolean {
  if (isUsdaSearchPer100Food(food)) return false;
  if (!trimmedServingSize(food)) return false;
  if ('macrosArePerServing' in food && food.macrosArePerServing === true) return true;
  if ('favorite_id' in food) return true;
  return false;
}

function applyQuantityDefaultsForSelectedFood(food: FoodResult | FavoriteFoodItem) {
  if (isUsdaSearchPer100Food(food)) {
    const fr = food;
    if (fr.usdaDeclaredServingGrams != null && fr.usdaDeclaredServingGrams > 0) {
      return { qty: '1', unit: 'serving' as const };
    }
    const u = fr.defaultBarcodeMassUnit ?? 'g';
    return { qty: '100', unit: u };
  }
  if (useServingPortionDefaults(food)) {
    return { qty: '1', unit: 'serving' as const };
  }
  if ('macrosArePerServing' in food && food.macrosArePerServing) {
    return { qty: '1', unit: 'serving' as const };
  }
  if ('defaultBarcodeMassUnit' in food && food.defaultBarcodeMassUnit) {
    return { qty: '100', unit: food.defaultBarcodeMassUnit };
  }
  return { qty: '1', unit: 'serving' as const };
}

/** Live + log totals from selected food, quantity, and unit. */
function macrosForQuantity(
  food: FoodResult | FavoriteFoodItem,
  quantity: number,
  unit: string,
): { calories: number; protein: number; carbs: number; fat: number } {
  const q = quantity > 0 ? quantity : 1;

  if (isUsdaSearchPer100Food(food)) {
    const grams = totalGramsForUsdaPer100Food(food, q, unit);
    const factor = grams / 100;
    const p = food.per100g!;
    return {
      calories: Math.round(p.calories * factor),
      protein: Math.round(p.protein * factor * 10) / 10,
      carbs: Math.round(p.carbs * factor * 10) / 10,
      fat: Math.round(p.fat * factor * 10) / 10,
    };
  }

  if (
    'favorite_id' in food &&
    trimmedServingSize(food) &&
    (unit === 'serving' || isPieceServingUnit(unit))
  ) {
    return {
      calories: Math.round(food.calories * q),
      protein: Math.round(food.protein * q * 10) / 10,
      carbs: Math.round(food.carbs * q * 10) / 10,
      fat: Math.round(food.fat * q * 10) / 10,
    };
  }

  if ('macrosArePerServing' in food && food.macrosArePerServing === true) {
    if (unit === 'serving' || isPieceServingUnit(unit)) {
      return {
        calories: Math.round(food.calories * q),
        protein: Math.round(food.protein * q * 10) / 10,
        carbs: Math.round(food.carbs * q * 10) / 10,
        fat: Math.round(food.fat * q * 10) / 10,
      };
    }
    const fr = food as FoodResult;
    const p100 = fr.per100g;
    if (
      p100 &&
      (p100.calories > 0 || p100.protein > 0 || p100.carbs > 0 || p100.fat > 0)
    ) {
      return computedMacros(p100, q, unit);
    }
    return {
      calories: Math.round(food.calories * q),
      protein: Math.round(food.protein * q * 10) / 10,
      carbs: Math.round(food.carbs * q * 10) / 10,
      fat: Math.round(food.fat * q * 10) / 10,
    };
  }

  if (isPieceServingUnit(unit)) {
    return {
      calories: Math.round(food.calories * q),
      protein: Math.round(food.protein * q * 10) / 10,
      carbs: Math.round(food.carbs * q * 10) / 10,
      fat: Math.round(food.fat * q * 10) / 10,
    };
  }

  return computedMacros(
    {
      calories: food.calories,
      protein: food.protein,
      carbs: food.carbs,
      fat: food.fat,
    },
    q,
    unit,
  );
}

function nutrientValueByNumber(nutrients: any[], nutrientNumber: string): number {
  const match = (nutrients || []).find((n: any) => String(n?.nutrientNumber ?? '') === nutrientNumber);
  return Number(match?.value) || 0;
}

async function upsertLoggedFoodRow(
  db: { runAsync: (sql: string, params?: unknown[]) => Promise<void> },
  opts: {
    replaceLoggedFoodId: number | null | undefined;
    logId: number;
    food_name: string;
    brand: string | null;
    meal_type_lower: string;
    serving_size: string;
    quantity: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  },
): Promise<void> {
  const {
    replaceLoggedFoodId,
    logId,
    food_name,
    brand,
    meal_type_lower,
    serving_size,
    quantity,
    calories,
    protein,
    carbs,
    fat,
  } = opts;
  if (replaceLoggedFoodId != null) {
    const args = [
      food_name,
      brand,
      meal_type_lower,
      serving_size,
      quantity,
      calories,
      protein,
      carbs,
      fat,
      replaceLoggedFoodId,
    ];
    try {
      await db.runAsync(
        'UPDATE LoggedFoods SET food_name = ?, brand = ?, meal_type = ?, unit = ?, quantity = ?, calories = ?, protein = ?, carbs = ?, fat = ? WHERE logged_food_id = ?',
        args,
      );
    } catch {
      await db.runAsync(
        'UPDATE LoggedFoods SET food_name = ?, brand = ?, meal_type = ?, serving_size = ?, quantity = ?, calories = ?, protein = ?, carbs = ?, fat = ? WHERE logged_food_id = ?',
        args,
      );
    }
    return;
  }
  await db.runAsync(
    `INSERT INTO LoggedFoods (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      logId,
      food_name,
      brand,
      meal_type_lower,
      serving_size,
      quantity,
      calories,
      protein,
      carbs,
      fat,
    ],
  );
}

export default function AddFoodModal({
  visible,
  mealType,
  selectedDate,
  onClose,
  onFoodAdded,
  replaceLoggedFoodId = null,
  headerTitle: headerTitleProp,
}: AddFoodModalProps) {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const [activeTab, setActiveTab] = useState<'search' | 'favorites'>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FoodResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [favoriteFoods, setFavoriteFoods] = useState<FavoriteFoodItem[]>([]);
  const [showQuantityModal, setShowQuantityModal] = useState(false);
  const [selectedFood, setSelectedFood] = useState<FoodResult | FavoriteFoodItem | null>(null);
  const [favoritedSignatures, setFavoritedSignatures] = useState<Set<string>>(new Set());
  const [qtyValue, setQtyValue] = useState('1');
  const [qtyUnit, setQtyUnit] = useState<string>('serving');
  const [qtyRelevantUnits, setQtyRelevantUnits] = useState<string[]>(() => getRelevantUnits('', null));
  const [qtyMealType, setQtyMealType] = useState<string>('Breakfast');
  const [unitDropdownOpen, setUnitDropdownOpen] = useState(false);

  const syncQuantityModalFromFood = useCallback((food: FoodResult | FavoriteFoodItem) => {
    const ss = trimmedServingSize(food) || null;
    const def = applyQuantityDefaultsForSelectedFood(food);
    let units = [...getRelevantUnits(food.food_name, ss)];
    if (!units.some((u) => u.toLowerCase() === String(def.unit).toLowerCase())) {
      units = [def.unit, ...units];
    }
    setQtyRelevantUnits(units);
    setQtyValue(def.qty);
    setQtyUnit(pickDefaultUnitForFood(food.food_name, ss, def.unit));
  }, []);
  const [barcodeScannerVisible, setBarcodeScannerVisible] = useState(false);
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const lastScannedCode = React.useRef<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualFoodName, setManualFoodName] = useState('');
  const [manualBrand, setManualBrand] = useState('');
  const [manualServingSize, setManualServingSize] = useState('');
  const [manualCalories, setManualCalories] = useState('');
  const [manualProtein, setManualProtein] = useState('');
  const [manualCarbs, setManualCarbs] = useState('');
  const [manualFat, setManualFat] = useState('');

  const resolvedHeaderTitle =
    headerTitleProp ?? (replaceLoggedFoodId != null ? 'Change food' : 'Add Food');
  const confirmLogLabel = replaceLoggedFoodId != null ? 'Save' : 'Add to Log';

  const loadFavorites = useCallback(async () => {
    try {
      await initNutritionDb(db);
      const rows = await db.getAllAsync<{ favorite_id: number; food_name: string; brand: string | null; serving_size: string | null; calories: number; protein: number; carbs: number; fat: number }>(
        'SELECT favorite_id, food_name, brand, serving_size, calories, protein, carbs, fat FROM FavoriteFoods ORDER BY favorite_id DESC'
      );
      setFavoriteFoods(rows.map((r) => ({
        favorite_id: r.favorite_id,
        food_name: r.food_name,
        brand: r.brand,
        serving_size: r.serving_size,
        calories: r.calories ?? 0,
        protein: r.protein ?? 0,
        carbs: r.carbs ?? 0,
        fat: r.fat ?? 0,
      })));
      setFavoritedSignatures(new Set(rows.map((r) => favoriteSignature(r.food_name, r.brand))));
    } catch (e) {
      console.log('loadFavorites error:', e);
    }
  }, [db]);

  useEffect(() => {
    if (visible) loadFavorites();
  }, [visible, loadFavorites]);

  useEffect(() => {
    if (visible && activeTab === 'favorites') {
      loadFavorites();
    }
  }, [visible, activeTab, loadFavorites]);

  const toggleFavoriteSearch = async (item: FoodResult) => {
    const sig = favoriteSignature(item.food_name, item.brand);
    try {
      await initNutritionDb(db);
      if (favoritedSignatures.has(sig)) {
        await db.runAsync(
          "DELETE FROM FavoriteFoods WHERE food_name = ? AND (COALESCE(brand,'') = COALESCE(?,''))",
          [item.food_name, item.brand]
        );
        setFavoritedSignatures((prev) => { const n = new Set(prev); n.delete(sig); return n; });
        setFavoriteFoods((prev) => prev.filter((f) => favoriteSignature(f.food_name, f.brand) !== sig));
      } else {
        await db.runAsync(
          'INSERT INTO FavoriteFoods (food_name, brand, serving_size, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [item.food_name, item.brand, trimmedServingSize(item) || null, item.calories, item.protein, item.carbs, item.fat]
        );
        setFavoritedSignatures((prev) => new Set([...prev, sig]));
        const rows = await db.getAllAsync<{ favorite_id: number; food_name: string; brand: string | null; serving_size: string | null; calories: number; protein: number; carbs: number; fat: number }>(
          'SELECT favorite_id, food_name, brand, serving_size, calories, protein, carbs, fat FROM FavoriteFoods ORDER BY favorite_id DESC LIMIT 1'
        );
        if (rows[0]) setFavoriteFoods((prev) => [{ favorite_id: rows[0].favorite_id, food_name: rows[0].food_name, brand: rows[0].brand, serving_size: rows[0].serving_size, calories: rows[0].calories ?? 0, protein: rows[0].protein ?? 0, carbs: rows[0].carbs ?? 0, fat: rows[0].fat ?? 0 }, ...prev]);
      }
    } catch (e) {
      console.log('toggleFavoriteSearch error:', e);
    }
  };

  const removeFavoriteById = async (fav: FavoriteFoodItem) => {
    try {
      await initNutritionDb(db);
      await db.runAsync('DELETE FROM FavoriteFoods WHERE favorite_id = ?', [fav.favorite_id]);
      const sig = favoriteSignature(fav.food_name, fav.brand);
      setFavoritedSignatures((prev) => { const n = new Set(prev); n.delete(sig); return n; });
      setFavoriteFoods((prev) => prev.filter((f) => f.favorite_id !== fav.favorite_id));
    } catch (e) {
      console.log('removeFavoriteById error:', e);
    }
  };

  const openScanner = async () => {
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) {
        Alert.alert('Camera', 'Camera permission is needed to scan barcodes.');
        return;
      }
    }
    lastScannedCode.current = null;
    setBarcodeScannerVisible(true);
  };

  /**
   * Fetch a barcode lookup with a 5s timeout per attempt and a single 500ms retry.
   * Throws an Error tagged with the final failure reason (HTTP status or thrown message)
   * only after BOTH attempts fail. "Product not in response" is NOT a fetch failure — the
   * resolved JSON is returned and the caller decides whether `data.product` is missing.
   */
  const fetchBarcodeProductWithRetry = async (code: string): Promise<any> => {
    const url = `https://world.openfoodfacts.org/api/v0/product/${code}.json`;
    const attempt = async (): Promise<any> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
          const err: any = new Error(`HTTP ${res.status}`);
          err.status = res.status;
          throw err;
        }
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    };

    const describeFailure = (e: any): string => {
      if (e && typeof e === 'object') {
        if (typeof e.status === 'number') return `HTTP ${e.status}`;
        if (e.name === 'AbortError') return 'timeout after 5000ms';
        if (typeof e.message === 'string' && e.message.length > 0) return e.message;
      }
      return 'unknown error';
    };

    try {
      return await attempt();
    } catch (firstErr) {
      console.warn(
        `[Barcode Lookup] Failed for UPC ${code}: ${describeFailure(firstErr)} (attempt 1, retrying)`,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        return await attempt();
      } catch (secondErr) {
        console.warn(
          `[Barcode Lookup] Failed for UPC ${code}: ${describeFailure(secondErr)} (attempt 2, giving up)`,
        );
        throw secondErr;
      }
    }
  };

  const onBarcodeScanned = async (event: { data?: string; nativeEvent?: { data?: string } }) => {
    const code = event.data ?? event.nativeEvent?.data ?? '';
    if (!code || lastScannedCode.current === code) return;
    lastScannedCode.current = code;
    setBarcodeScannerVisible(false);
    setBarcodeLoading(true);
    try {
      const data = await fetchBarcodeProductWithRetry(code);
      const product = data?.product;
      if (!product) {
        Alert.alert('Not found', `No product found for barcode ${code}.`);
        setBarcodeLoading(false);
        return;
      }
      const food = normalizeOffProductFromBarcode(product);
      setSelectedFood(food);
      syncQuantityModalFromFood(food);
      setQtyMealType(mealType.charAt(0).toUpperCase() + mealType.slice(1));
      setShowQuantityModal(true);
    } catch (e) {
      Alert.alert('Error', 'Could not fetch product. Try again.');
    }
    setBarcodeLoading(false);
  };

  const queryCommonFoods = async (rawQuery: string): Promise<FoodResult[]> => {
    const lower = rawQuery.trim().toLowerCase();
    if (!lower) return [];
    try {
      await initNutritionDb(db);
      const wildcard = `%${lower}%`;
      const prefix = `${lower}%`;
      const rows = await db.getAllAsync<CommonFoodRow>(
        `SELECT id, name, search_terms, serving_size, serving_unit, calories, protein_g, carbs_g, fat_g
         FROM CommonFoods
         WHERE LOWER(name) LIKE ? OR search_terms LIKE ?
         ORDER BY
           CASE
             WHEN LOWER(name) = ? THEN 0
             WHEN LOWER(name) LIKE ? THEN 1
             ELSE 2
           END,
           name ASC
         LIMIT 10;`,
        [wildcard, wildcard, lower, prefix],
      );
      return rows.map(normalizeCommonFood);
    } catch (e) {
      console.log('CommonFoods query error:', e);
      return [];
    }
  };

  const runUsdaSearch = async (
    trimmedQuery: string,
    signal: AbortSignal,
  ): Promise<
    | { ok: true; results: FoodResult[] }
    | { ok: false; errorMessage: string }
  > => {
    const q = encodeURIComponent(trimmedQuery);
    const usdaUrl = `https://api.nal.usda.gov/fdc/v1/foods/search?query=${q}&api_key=${process.env.EXPO_PUBLIC_USDA_API_KEY}&pageSize=20&dataType=Branded,SR%20Legacy`;

    let res: Response;
    let responseText: string;
    try {
      res = await fetch(usdaUrl, { signal });
      responseText = await res.text();
    } catch (e) {
      const isAbort =
        (e instanceof Error && e.name === 'AbortError') ||
        (typeof DOMException !== 'undefined' &&
          e instanceof DOMException &&
          e.name === 'AbortError');
      console.error('[AddFoodModal] USDA search: fetch failed', {
        url: usdaUrl,
        error: e,
        aborted: isAbort,
      });
      return {
        ok: false,
        errorMessage: isAbort
          ? SEARCH_SLOW_OR_UNAVAILABLE_MESSAGE
          : 'Search request failed. Check your connection and try again.',
      };
    }

    if (res.status === 503) {
      return { ok: false, errorMessage: SEARCH_SLOW_OR_UNAVAILABLE_MESSAGE };
    }

    let data: any;
    try {
      data = responseText ? JSON.parse(responseText) : null;
    } catch (parseErr) {
      console.error('[AddFoodModal] USDA search: invalid JSON', {
        url: usdaUrl,
        status: res.status,
        statusText: res.statusText,
        responseText,
        parseErr,
      });
      return {
        ok: false,
        errorMessage: `Search returned an invalid response (HTTP ${res.status}).`,
      };
    }

    if (!res.ok) {
      console.error('[AddFoodModal] USDA search: HTTP error', {
        url: usdaUrl,
        status: res.status,
        statusText: res.statusText,
        response: data,
        responseText,
      });
      return {
        ok: false,
        errorMessage: `Search failed (HTTP ${res.status}).`,
      };
    }

    const rawFoods = Array.isArray(data?.foods) ? data.foods : [];
    const normalized = rawFoods
      .map((row: Record<string, unknown>) => normalizeUsdaSearchFood(row))
      .filter((f: FoodResult | null): f is FoodResult => f != null);
    if (normalized.length === 0) {
      console.error('[AddFoodModal] USDA search: no foods in response', {
        url: usdaUrl,
        response: data,
      });
    }
    return { ok: true, results: normalized };
  };

  const runSearch = async () => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) return;
    setSearching(true);
    setSearchError(null);

    // Tier 1: curated CommonFoods — show immediately while remote sources load.
    const curatedAll = await queryCommonFoods(trimmedQuery);
    const curatedResults = curatedAll.slice(0, 10);
    setSearchResults(curatedResults);
    const curatedNameSet = new Set(
      curatedResults.map((r) => r.food_name.trim().toLowerCase()),
    );

    // Tiers 2 & 3: FatSecret + USDA in parallel under one timeout/abort.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FOOD_SEARCH_TIMEOUT_MS);
    const signal = controller.signal;

    const fatsecretPromise = searchFatSecret(trimmedQuery, signal).catch(
      (e) => {
        console.error('[AddFoodModal] FatSecret search failed:', e);
        return [] as FoodResult[];
      },
    );
    const usdaPromise = runUsdaSearch(trimmedQuery, signal);

    let fatsecretRaw: FoodResult[] = [];
    let usdaOutcome:
      | { ok: true; results: FoodResult[] }
      | { ok: false; errorMessage: string } = { ok: true, results: [] };
    try {
      [fatsecretRaw, usdaOutcome] = await Promise.all([
        fatsecretPromise,
        usdaPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    const fatsecretResults = fatsecretRaw
      .filter(
        (r) => !curatedNameSet.has(r.food_name.trim().toLowerCase()),
      )
      .slice(0, 15);

    const usdaResults = usdaOutcome.ok
      ? usdaOutcome.results
          .filter(
            (r) => !curatedNameSet.has(r.food_name.trim().toLowerCase()),
          )
          .slice(0, 15)
      : [];

    setSearchResults([...curatedResults, ...fatsecretResults, ...usdaResults]);

    if (
      curatedResults.length === 0 &&
      fatsecretResults.length === 0 &&
      !usdaOutcome.ok
    ) {
      setSearchError(usdaOutcome.errorMessage);
    }
    setSearching(false);
  };

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchError(null);
    setSearching(false);
    setShowManualForm(false);
  }, []);

  const resetManualForm = () => {
    setShowManualForm(false);
    setManualFoodName('');
    setManualBrand('');
    setManualServingSize('');
    setManualCalories('');
    setManualProtein('');
    setManualCarbs('');
    setManualFat('');
  };

  const handleAddToLog = async () => {
    if (!selectedFood) return;
    const quantity = parseFloat(qtyValue) || 1;
    const {
      calories: computedCals,
      protein: computedProtein,
      carbs: computedCarbs,
      fat: computedFat,
    } = macrosForQuantity(selectedFood, quantity, qtyUnit);
    const today = selectedDate || new Date().toISOString().split('T')[0];
    const baseServing = trimmedServingSize(selectedFood);
    const servingSizeForDb =
      qtyUnit === 'serving'
        ? baseServing || 'serving'
        : qtyUnit;
    try {
      await initNutritionDb(db);
      await db.runAsync('INSERT OR IGNORE INTO DailyLog (log_date) VALUES (?)', [today]);
      const logRow = await db.getFirstAsync<{ log_id: number }>(
        'SELECT log_id FROM DailyLog WHERE log_date = ?',
        [today],
      );
      if (!logRow) throw new Error('DailyLog row not found');
      await upsertLoggedFoodRow(db, {
        replaceLoggedFoodId,
        logId: logRow.log_id,
        food_name: selectedFood.food_name,
        brand: selectedFood.brand,
        meal_type_lower: qtyMealType.toLowerCase(),
        serving_size: servingSizeForDb,
        quantity,
        calories: computedCals,
        protein: computedProtein,
        carbs: computedCarbs,
        fat: computedFat,
      });
      setShowQuantityModal(false);
      setSelectedFood(null);
      setUnitDropdownOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      setSearching(false);
      onFoodAdded?.();
      onClose();
    } catch (e) {
      console.error('handleAddToLog error:', e);
    }
  };

  const handleAddManualToLog = async () => {
    if (!manualFoodName.trim()) {
      Alert.alert('Missing food name', 'Please enter a food name.');
      return;
    }
    const calories = parseFloat(manualCalories) || 0;
    const protein = parseFloat(manualProtein) || 0;
    const carbs = parseFloat(manualCarbs) || 0;
    const fat = parseFloat(manualFat) || 0;
    const servingSize = manualServingSize.trim() || 'serving';
    const today = selectedDate || new Date().toISOString().split('T')[0];
    try {
      await initNutritionDb(db);
      await db.runAsync('INSERT OR IGNORE INTO DailyLog (log_date) VALUES (?)', [today]);
      const logRow = await db.getFirstAsync<{ log_id: number }>('SELECT log_id FROM DailyLog WHERE log_date = ?', [today]);
      if (!logRow) throw new Error('DailyLog row not found');
      await upsertLoggedFoodRow(db, {
        replaceLoggedFoodId,
        logId: logRow.log_id,
        food_name: manualFoodName.trim(),
        brand: manualBrand.trim() || null,
        meal_type_lower: mealType.toLowerCase(),
        serving_size: servingSize,
        quantity: 1,
        calories,
        protein,
        carbs,
        fat,
      });
      onFoodAdded?.();
      resetManualForm();
      onClose();
    } catch (e) {
      console.error('handleAddManualToLog error:', e);
    }
  };

  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 12);

  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent>
      <View style={[styles.safeArea, { backgroundColor: theme.background, paddingTop: topPadding, paddingBottom: insets.bottom }]}>
        <View style={styles.container}>
          <View style={[styles.header, { borderBottomColor: theme.border }]}>
            <Text style={[styles.headerTitle, { color: theme.text }]}>{resolvedHeaderTitle}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}>
              <Ionicons name="close" size={28} color={theme.text} />
            </TouchableOpacity>
          </View>

          {/* Tabs: Search | Favorites only */}
          <View style={[styles.tabRow, { borderBottomColor: theme.border }]}>
            <TouchableOpacity
              style={[styles.tab, activeTab === 'search' && styles.tabActive]}
              onPress={() => setActiveTab('search')}
            >
              <Text style={[styles.tabText, { color: activeTab === 'search' ? SAGE : theme.textSecondary }]}>Search</Text>
              {activeTab === 'search' && <View style={[styles.tabUnderline, { backgroundColor: SAGE }]} />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, activeTab === 'favorites' && styles.tabActive]}
              onPress={() => setActiveTab('favorites')}
            >
              <Text style={[styles.tabText, { color: activeTab === 'favorites' ? SAGE : theme.textSecondary }]}>Favorites</Text>
              {activeTab === 'favorites' && <View style={[styles.tabUnderline, { backgroundColor: SAGE }]} />}
            </TouchableOpacity>
          </View>

          {activeTab === 'search' && (
            <View style={styles.searchSection}>
              {/* Search bar with barcode icon inside (right side) */}
              <View style={[styles.searchRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
                <TextInput
                  style={[
                    styles.searchInput,
                    searchQuery.trim().length > 0 && styles.searchInputWithClear,
                    { color: theme.text },
                  ]}
                  placeholder="Search foods"
                  placeholderTextColor="#888"
                  value={searchQuery}
                  onChangeText={(t) => {
                    setSearchQuery(t);
                    setSearchError(null);
                  }}
                  onSubmitEditing={runSearch}
                  returnKeyType="search"
                />
                {searchQuery.trim().length > 0 ? (
                  <TouchableOpacity
                    onPress={clearSearch}
                    style={styles.clearSearchBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel="Clear search"
                  >
                    <Ionicons name="close-circle" size={18} color="#9AA0A6" />
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity onPress={openScanner} style={styles.barcodeBtn}>
                  <Ionicons name="barcode-outline" size={24} color={SAGE} />
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={[styles.searchSubmitBtn, { backgroundColor: SAGE }]} onPress={runSearch}>
                <Text style={styles.searchSubmitText}>Search</Text>
              </TouchableOpacity>
              {searching && <ActivityIndicator size="small" color={SAGE} style={styles.searchSpinner} />}
              {searchError != null && searchError !== '' && (
                <View
                  style={[
                    styles.searchErrorBanner,
                    { backgroundColor: theme.card, borderColor: '#C62828' },
                  ]}
                >
                  <Text style={styles.searchErrorText}>{searchError}</Text>
                </View>
              )}
              <ScrollView style={styles.searchResultsScroll} showsVerticalScrollIndicator={false}>
                {searchResults.map((item) => (
                  <View key={item.code} style={[styles.foodRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
                    <TouchableOpacity
                      style={{ flex: 1 }}
                      activeOpacity={0.6}
                      onPress={() => {
                        setSelectedFood(item);
                        syncQuantityModalFromFood(item);
                        setQtyMealType(mealType.charAt(0).toUpperCase() + mealType.slice(1));
                        setShowQuantityModal(true);
                      }}
                    >
                      <Text style={[styles.foodName, { color: theme.text }]}>{item.food_name}</Text>
                      <Text style={[styles.foodBrand, { color: theme.textSecondary }]}>{item.brand}</Text>
                      <Text style={[styles.foodMacros, { color: theme.textSecondary }]}>
                        {item.calories} cal · P {item.protein}g · C {item.carbs}g · F {item.fat}g
                      </Text>
                      {!!item.serving_size && (
                        <Text style={[styles.foodMacros, { color: theme.textSecondary }]}>Serving: {item.serving_size}</Text>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={{ padding: 8 }}
                      activeOpacity={0.6}
                      onPress={() => toggleFavoriteSearch(item)}
                    >
                      <Ionicons
                        name={favoritedSignatures.has(favoriteSignature(item.food_name, item.brand)) ? 'heart' : 'heart-outline'}
                        size={22}
                        color={SAGE}
                      />
                    </TouchableOpacity>
                  </View>
                ))}
                {!searching &&
                  !searchError &&
                  searchQuery.trim() &&
                  searchResults.length === 0 && (
                  <View>
                    <Text style={[styles.emptyText, { color: theme.textSecondary }]}>{NO_RESULTS_MESSAGE}</Text>
                    <TouchableOpacity
                      style={[styles.searchSubmitBtn, { backgroundColor: theme.card, borderColor: theme.border, borderWidth: 1 }]}
                      onPress={() => setShowManualForm((v) => !v)}
                    >
                      <Text style={[styles.searchSubmitText, { color: theme.text }]}>Add it manually</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {showManualForm && (
                  <View style={[styles.manualFormCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
                    <View style={[styles.quantityModalActions, styles.quantityModalActionsTop]}>
                      <TouchableOpacity
                        style={[styles.quantityBtn, { backgroundColor: theme.background }]}
                        onPress={resetManualForm}
                      >
                        <Text style={[styles.quantityBtnText, { color: theme.text }]}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.quantityBtn, { backgroundColor: SAGE }]}
                        onPress={handleAddManualToLog}
                      >
                        <Text style={styles.quantityBtnText}>{confirmLogLabel}</Text>
                      </TouchableOpacity>
                    </View>
                    <Text style={[styles.quantityModalLabel, { color: theme.text, marginTop: 0 }]}>Food name</Text>
                    <TextInput
                      style={[styles.quantityInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                      value={manualFoodName}
                      onChangeText={setManualFoodName}
                      placeholder="e.g. Greek yogurt"
                      placeholderTextColor="#888"
                    />
                    <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Brand (optional)</Text>
                    <TextInput
                      style={[styles.quantityInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                      value={manualBrand}
                      onChangeText={setManualBrand}
                      placeholder="e.g. Fage"
                      placeholderTextColor="#888"
                    />
                    <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Serving size</Text>
                    <TextInput
                      style={[styles.quantityInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                      value={manualServingSize}
                      onChangeText={setManualServingSize}
                      placeholder="e.g. 1 cup"
                      placeholderTextColor="#888"
                    />
                    <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Calories</Text>
                    <TextInput
                      style={[styles.quantityInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                      value={manualCalories}
                      onChangeText={setManualCalories}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor="#888"
                    />
                    <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Protein (g)</Text>
                    <TextInput
                      style={[styles.quantityInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                      value={manualProtein}
                      onChangeText={setManualProtein}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor="#888"
                    />
                    <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Carbs (g)</Text>
                    <TextInput
                      style={[styles.quantityInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                      value={manualCarbs}
                      onChangeText={setManualCarbs}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor="#888"
                    />
                    <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Fat (g)</Text>
                    <TextInput
                      style={[styles.quantityInput, { backgroundColor: theme.background, color: theme.text, borderColor: theme.border }]}
                      value={manualFat}
                      onChangeText={setManualFat}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      placeholderTextColor="#888"
                    />
                  </View>
                )}
              </ScrollView>
            </View>
          )}

          {activeTab === 'favorites' && (
            <View style={styles.favoritesSection}>
              {favoriteFoods.length === 0 ? (
                <Text style={[styles.emptyText, { color: theme.textSecondary }]}>No favorites yet. Search and add foods to favorites.</Text>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false}>
                  {favoriteFoods.map((item) => (
                    <View key={item.favorite_id} style={[styles.foodRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
                      <TouchableOpacity
                        style={{ flex: 1 }}
                        activeOpacity={0.6}
                        onPress={() => {
                          setSelectedFood(item);
                          syncQuantityModalFromFood(item);
                          setQtyMealType(mealType.charAt(0).toUpperCase() + mealType.slice(1));
                          setShowQuantityModal(true);
                        }}
                      >
                        <Text style={[styles.foodName, { color: theme.text }]}>{item.food_name}</Text>
                        <Text style={[styles.foodBrand, { color: theme.textSecondary }]}>{item.brand}</Text>
                        <Text style={[styles.foodMacros, { color: theme.textSecondary }]}>
                          {item.calories} cal · P {item.protein}g · C {item.carbs}g · F {item.fat}g
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={{ padding: 8 }}
                        activeOpacity={0.6}
                        onPress={() => removeFavoriteById(item)}
                      >
                        <Ionicons name="heart" size={22} color={SAGE} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          )}

          {/* QuantityModal — quantity, unit, live macros, meal selector, Add to Log */}
          {showQuantityModal && selectedFood && (() => {
            const quantity = parseFloat(qtyValue) || 0;
            const live = macrosForQuantity(
              selectedFood,
              quantity || 1,
              qtyUnit,
            );
            return (
              <View style={styles.quantityModalOverlay}>
                <KeyboardAvoidingView behavior="padding">
                <View style={[styles.quantityModalBox, { backgroundColor: theme.background }]}>
                  <View style={[styles.quantityModalActions, styles.quantityModalActionsTop]}>
                    <TouchableOpacity
                      style={[styles.quantityBtn, { backgroundColor: theme.card }]}
                      onPress={() => {
                        setShowQuantityModal(false);
                        setSelectedFood(null);
                        setUnitDropdownOpen(false);
                      }}
                    >
                      <Text style={[styles.quantityBtnText, { color: theme.text }]}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.quantityBtn, { backgroundColor: SAGE }]} onPress={handleAddToLog}>
                      <Text style={styles.quantityBtnText}>{confirmLogLabel}</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={[styles.quantityModalTitle, { color: theme.text }]}>{selectedFood.food_name}</Text>
                  {!!selectedFood.brand && (
                    <Text style={[styles.quantityModalBrand, { color: theme.textSecondary }]}>{selectedFood.brand}</Text>
                  )}
                  <Text style={[styles.quantityModalLive, { color: theme.text }]}>
                    {live.calories} cal · P {live.protein}g · C {live.carbs}g · F {live.fat}g
                  </Text>

                  <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Quantity</Text>
                  <TextInput
                    style={[styles.quantityInput, { backgroundColor: theme.card, color: theme.text, borderColor: theme.border }]}
                    value={qtyValue}
                    onChangeText={setQtyValue}
                    keyboardType="decimal-pad"
                    placeholder="1"
                    placeholderTextColor="#888"
                  />

                  <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Unit</Text>
                  <TouchableOpacity
                    style={[styles.quantityInput, styles.unitDropdownTrigger, { backgroundColor: theme.card, borderColor: theme.border }]}
                    onPress={() => setUnitDropdownOpen((o) => !o)}
                  >
                    <Text style={[styles.unitDropdownTriggerText, { color: theme.text }]} numberOfLines={1}>{qtyUnit}</Text>
                    <Ionicons name={unitDropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color={theme.text} />
                  </TouchableOpacity>
                  {unitDropdownOpen && (
                    <View style={[styles.unitDropdownList, { backgroundColor: theme.card, borderColor: theme.border }]}>
                      <ScrollView style={styles.unitDropdownScroll} nestedScrollEnabled showsVerticalScrollIndicator={false}>
                        {qtyRelevantUnits.map((u) => (
                          <TouchableOpacity
                            key={u}
                            style={[styles.unitDropdownOption, { backgroundColor: qtyUnit === u ? SAGE : 'transparent' }]}
                            onPress={() => { setQtyUnit(u); setUnitDropdownOpen(false); }}
                          >
                            <Text style={[styles.unitDropdownOptionText, { color: qtyUnit === u ? '#fff' : theme.text }]}>{u}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}

                  <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Meal</Text>
                  <View style={styles.unitRow}>
                    {MEAL_OPTIONS.map((m) => (
                      <TouchableOpacity
                        key={m}
                        style={[styles.unitChip, qtyMealType === m && styles.unitChipActive, { borderColor: theme.border, backgroundColor: qtyMealType === m ? SAGE : theme.card }]}
                        onPress={() => setQtyMealType(m)}
                      >
                        <Text style={[styles.unitChipText, { color: qtyMealType === m ? '#fff' : theme.text }]}>{m}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                </KeyboardAvoidingView>
              </View>
            );
          })()}
        </View>
      </View>

      {/* Full-screen barcode scanner overlay */}
      <Modal visible={barcodeScannerVisible} animationType="slide" statusBarTranslucent>
        <View style={styles.scannerFullScreen}>
          <CameraView style={StyleSheet.absoluteFill} onBarcodeScanned={onBarcodeScanned} />
          <SafeAreaView style={styles.scannerHeader} edges={['top']}>
            <TouchableOpacity onPress={() => setBarcodeScannerVisible(false)} style={styles.scannerCloseBtn}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.scannerTitle}>Scan barcode</Text>
          </SafeAreaView>
        </View>
      </Modal>

      {barcodeLoading && (
        <View style={styles.barcodeLoadingOverlay}>
          <ActivityIndicator size="large" color={SAGE} />
          <Text style={[styles.barcodeLoadingText, { color: theme.text }]}>Looking up product...</Text>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    paddingTop: 14,
    paddingBottom: 14,
    minHeight: 56,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  closeBtn: { padding: 12, margin: -8 },
  tabRow: { flexDirection: 'row', borderBottomWidth: 1 },
  tab: { paddingVertical: 14, paddingHorizontal: 24, marginBottom: -1 },
  tabActive: {},
  tabText: { fontSize: 15, fontWeight: '600' },
  tabUnderline: { position: 'absolute', left: 12, right: 12, bottom: 0, height: 2, borderRadius: 1 },
  searchSection: { flex: 1, padding: 16 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: 16 },
  searchInputWithClear: { paddingRight: 8 },
  clearSearchBtn: {
    paddingHorizontal: 4,
    paddingVertical: 4,
    justifyContent: 'center',
    alignItems: 'center',
  },
  barcodeBtn: { padding: 8 },
  searchSubmitBtn: { paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginBottom: 8 },
  searchSubmitText: { color: '#fff', fontWeight: '600' },
  searchSpinner: { marginVertical: 8 },
  searchErrorBanner: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  searchErrorText: {
    color: '#C62828',
    fontSize: 14,
    fontWeight: '600',
  },
  searchResultsScroll: { flex: 1 },
  manualFormCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    marginBottom: 12,
  },
  foodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 10,
  },
  foodName: { fontSize: 16, fontWeight: '600' },
  foodBrand: { fontSize: 13, marginTop: 4 },
  foodMacros: { fontSize: 12, marginTop: 2 },
  emptyText: { textAlign: 'center', paddingVertical: 24, fontSize: 14 },
  favoritesSection: { flex: 1, padding: 16 },
  quantityModalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  quantityModalBox: { borderRadius: 16, padding: 20, overflow: 'hidden', maxWidth: '100%' },
  quantityModalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  quantityModalBrand: { fontSize: 14, marginBottom: 6 },
  quantityModalServingLabel: { fontSize: 14, marginTop: 2, marginBottom: 8, fontWeight: '500' },
  quantityModalLabel: { fontSize: 14, fontWeight: '600', marginBottom: 6, marginTop: 8 },
  quantityInput: { borderWidth: 1, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12, fontSize: 16 },
  unitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  unitChip: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1 },
  unitChipActive: {},
  unitChipText: { fontSize: 13, fontWeight: '600' },
  unitDropdownTrigger: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 0 },
  unitDropdownTriggerText: { fontSize: 16, flex: 1, marginRight: 8 },
  unitDropdownList: { borderWidth: 1, borderRadius: 10, marginTop: 4, marginBottom: 4, maxHeight: 160, overflow: 'hidden' },
  unitDropdownScroll: { maxHeight: 156 },
  unitDropdownOption: { paddingVertical: 8, paddingHorizontal: 12 },
  unitDropdownOptionText: { fontSize: 15 },
  quantityModalLive: { fontSize: 15, fontWeight: '600', marginTop: 2, marginBottom: 14 },
  quantityModalActions: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
  quantityModalActionsTop: { marginBottom: 12, marginTop: 0 },
  quantityBtn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10 },
  quantityBtnText: { color: '#fff', fontWeight: '600' },
  scannerFullScreen: { flex: 1, backgroundColor: '#000' },
  scannerHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  scannerCloseBtn: { padding: 8 },
  scannerTitle: { fontSize: 18, fontWeight: '600', color: '#fff' },
  barcodeLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  barcodeLoadingText: { marginTop: 12, fontSize: 16 },
});
