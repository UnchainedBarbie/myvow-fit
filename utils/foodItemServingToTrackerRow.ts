/**
 * Meal plan `FoodItems.serving_size` is often a full amount string ("6 oz", "30g", "1 cup").
 * `LoggedFoods` expects `quantity` × unit, with `serving_size` storing the unit token for the tracker UI
 * (same convention as AddFoodModal manual logging).
 */
export function foodItemServingToTrackerFields(
  servingSize: string | null | undefined,
): { quantity: number; unitToken: string } {
  const raw = String(servingSize ?? '').trim();
  if (!raw) {
    return { quantity: 1, unitToken: 'serving' };
  }
  const normalized = raw.replace(',', '.');
  const m = normalized.match(/^(\d+(?:\.\d+)?)\s*(.*)$/);
  if (!m) {
    return { quantity: 1, unitToken: raw };
  }
  const amount = parseFloat(m[1]);
  const rest = (m[2] || '').trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    return { quantity: 1, unitToken: raw };
  }
  if (!rest) {
    return { quantity: amount, unitToken: 'serving' };
  }
  const unitNorm = rest.replace(/\b(servings)\b/gi, 'serving').trim().toLowerCase();
  return { quantity: amount, unitToken: unitNorm || 'serving' };
}
