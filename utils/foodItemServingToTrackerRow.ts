/**
 * Meal plan `FoodItems.serving_size` is often a full amount string ("6 oz", "30g", "1 cup").
 * `LoggedFoods` expects `quantity` × unit, with `serving_size` storing the unit token for the tracker UI
 * (same convention as AddFoodModal manual logging).
 */
import { preferSizeUnitOverWholeServingText } from './getRelevantUnits';

function normalizeUnitToken(rest: string): string {
  const unitNorm = rest.replace(/\b(servings)\b/gi, 'serving').trim().toLowerCase();
  return unitNorm || 'serving';
}

export function foodItemServingToTrackerFields(
  servingSize: string | null | undefined,
): { quantity: number; unitToken: string } {
  const raw = String(servingSize ?? '').trim();
  if (!raw) {
    return { quantity: 1, unitToken: preferSizeUnitOverWholeServingText('') };
  }
  const normalized = raw.replace(',', '.');

  const frac = normalized.match(/^(\d+)\s*\/\s*(\d+)(?:\s+(.+))?$/);
  if (frac) {
    const num = parseInt(frac[1], 10);
    const den = parseInt(frac[2], 10);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num >= 0) {
      const quantity = num / den;
      if (Number.isFinite(quantity) && quantity > 0) {
        const rest = (frac[3] ?? '').trim();
        const token = rest || 'serving';
        return {
          quantity,
          unitToken: preferSizeUnitOverWholeServingText(token),
        };
      }
    }
  }

  const dec = normalized.match(/^(\d+(?:\.\d+)?)(?!\s*\/)\s+(.+)$/);
  if (dec) {
    const amount = parseFloat(dec[1]);
    const rest = (dec[2] || '').trim();
    if (Number.isFinite(amount) && amount > 0) {
      const token = normalizeUnitToken(rest);
      return {
        quantity: amount,
        unitToken: preferSizeUnitOverWholeServingText(token),
      };
    }
  }

  const attached = normalized.match(/^(\d+(?:\.\d+)?)([a-zA-Z].*)$/);
  if (attached) {
    const amount = parseFloat(attached[1]);
    const rest = (attached[2] || '').trim();
    if (Number.isFinite(amount) && amount > 0) {
      const token = normalizeUnitToken(rest);
      return {
        quantity: amount,
        unitToken: preferSizeUnitOverWholeServingText(token),
      };
    }
  }

  return { quantity: 1, unitToken: preferSizeUnitOverWholeServingText(raw) };
}
