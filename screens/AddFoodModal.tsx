/**
 * Add Food modal: Search (Open Food Facts) + Favorites.
 * Barcode icon is inside the search bar. Title and content respect safe area.
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
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useSQLiteContext } from 'expo-sqlite';
import Ionicons from 'react-native-vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { initNutritionDb } from '../utils/nutritionDb';

const SAGE = '#7C9A7E';

/** Units suitable for general food (e.g. fruit, packaged) when adding from search. */
const UNITS = ['g', 'oz', 'serving', 'cup'] as const;
const MEAL_OPTIONS = ['Breakfast', 'Snack', 'Lunch', 'Dinner'] as const;

/** Grams per unit (for volume we approximate as weight). */
function gramsPerUnit(unit: string): number {
  switch (unit) {
    case 'g': return 1;
    case 'oz': return 28.35;
    case 'serving': return 100;
    case 'cup': return 240;
    case 'tbsp': return 15;
    case 'tsp': return 5;
    case 'ml': return 1;
    case 'lb': return 453.59;
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
  source?: 'off' | 'usda';
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

export type AddFoodModalProps = {
  visible: boolean;
  mealType: string;
  selectedDate: string;
  onClose: () => void;
  onFoodAdded?: () => void;
};

function normalizeOffProduct(p: any): FoodResult {
  const nut = p.nutriments || {};
  const energyKcal = nut['energy-kcal_100g'] ?? nut.energy_100g ?? 0;
  return {
    code: p.code || '',
    food_name: p.product_name || p.food_name || 'Unknown',
    brand: p.brands || p.brand || null,
    calories: Math.round(Number(energyKcal) || 0),
    protein: Math.round(Number(nut.proteins_100g) || 0),
    carbs: Math.round(Number(nut.carbohydrates_100g) || 0),
    fat: Math.round(Number(nut.fat_100g) || 0),
    serving_size: p.serving_size || null,
    source: 'off',
  };
}

function nutrientValueByNumber(nutrients: any[], nutrientNumber: string): number {
  const match = (nutrients || []).find((n: any) => String(n?.nutrientNumber ?? '') === nutrientNumber);
  return Number(match?.value) || 0;
}

function normalizeUsdaFood(f: any): FoodResult {
  const nutrients = f?.foodNutrients || [];
  const servingSize = f?.servingSize ? `${f.servingSize}${f?.servingSizeUnit ? ` ${f.servingSizeUnit}` : ''}` : null;
  return {
    code: String(f?.fdcId ?? ''),
    food_name: f?.description || 'Unknown',
    brand: f?.brandOwner || f?.brandName || null,
    calories: Math.round(nutrientValueByNumber(nutrients, '208')),
    protein: Math.round(nutrientValueByNumber(nutrients, '203') * 10) / 10,
    carbs: Math.round(nutrientValueByNumber(nutrients, '205') * 10) / 10,
    fat: Math.round(nutrientValueByNumber(nutrients, '204') * 10) / 10,
    serving_size: servingSize,
    source: 'usda',
  };
}

export default function AddFoodModal({
  visible,
  mealType,
  selectedDate,
  onClose,
  onFoodAdded,
}: AddFoodModalProps) {
  const { theme } = useTheme();
  const db = useSQLiteContext();
  const [activeTab, setActiveTab] = useState<'search' | 'favorites'>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FoodResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [favoriteFoods, setFavoriteFoods] = useState<FavoriteFoodItem[]>([]);
  const [showQuantityModal, setShowQuantityModal] = useState(false);
  const [selectedFood, setSelectedFood] = useState<FoodResult | FavoriteFoodItem | null>(null);
  const [favoritedSignatures, setFavoritedSignatures] = useState<Set<string>>(new Set());
  const [qtyValue, setQtyValue] = useState('1');
  const [qtyUnit, setQtyUnit] = useState<string>('serving');
  const [qtyMealType, setQtyMealType] = useState<string>('Breakfast');
  const [unitDropdownOpen, setUnitDropdownOpen] = useState(false);
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
          'INSERT INTO FavoriteFoods (food_name, brand, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?)',
          [item.food_name, item.brand, item.calories, item.protein, item.carbs, item.fat]
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

  const onBarcodeScanned = async (event: { data?: string; nativeEvent?: { data?: string } }) => {
    const code = event.data ?? event.nativeEvent?.data ?? '';
    if (!code || lastScannedCode.current === code) return;
    lastScannedCode.current = code;
    setBarcodeScannerVisible(false);
    setBarcodeLoading(true);
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v0/product/${code}.json`);
      const data = await res.json();
      const product = data.product;
      if (!product) {
        Alert.alert('Not found', `No product found for barcode ${code}.`);
        setBarcodeLoading(false);
        return;
      }
      const food = normalizeOffProduct(product);
      setSelectedFood(food);
      setQtyValue('1');
      setQtyUnit('serving');
      setQtyMealType(mealType.charAt(0).toUpperCase() + mealType.slice(1));
      setShowQuantityModal(true);
    } catch (e) {
      Alert.alert('Error', 'Could not fetch product. Try again.');
    }
    setBarcodeLoading(false);
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    setSearchResults([]);
    try {
      const q = encodeURIComponent(searchQuery.trim());
      const res = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=20`);
      const data = await res.json();
      const products = (data.products || []).filter((p: any) => p.code);
      const normalizedOff = products.map(normalizeOffProduct);
      if (normalizedOff.length > 0) {
        setSearchResults(normalizedOff);
      } else {
        const usdaRes = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?query=${q}&api_key=DEMO_KEY&pageSize=10`);
        const usdaData = await usdaRes.json();
        const usdaFoods = (usdaData?.foods || []).map(normalizeUsdaFood);
        setSearchResults(usdaFoods);
      }
    } catch (e) {
      setSearchResults([]);
    }
    setSearching(false);
  };

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
    const { calories: computedCals, protein: computedProtein, carbs: computedCarbs, fat: computedFat } = computedMacros(
      { calories: selectedFood.calories, protein: selectedFood.protein, carbs: selectedFood.carbs, fat: selectedFood.fat },
      quantity,
      qtyUnit
    );
    const today = selectedDate || new Date().toISOString().split('T')[0];
    try {
      await db.runAsync('INSERT OR IGNORE INTO DailyLog (log_date) VALUES (?)', [today]);
      const logRow = await db.getFirstAsync<{ log_id: number }>('SELECT log_id FROM DailyLog WHERE log_date = ?', [today]);
      if (!logRow) throw new Error('DailyLog row not found');
      await db.runAsync(
        `INSERT INTO LoggedFoods (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [logRow.log_id, selectedFood.food_name, selectedFood.brand, qtyMealType.toLowerCase(), qtyUnit, quantity, computedCals, computedProtein, computedCarbs, computedFat]
      );
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
      await db.runAsync('INSERT OR IGNORE INTO DailyLog (log_date) VALUES (?)', [today]);
      const logRow = await db.getFirstAsync<{ log_id: number }>('SELECT log_id FROM DailyLog WHERE log_date = ?', [today]);
      if (!logRow) throw new Error('DailyLog row not found');
      await db.runAsync(
        `INSERT INTO LoggedFoods (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logRow.log_id,
          manualFoodName.trim(),
          manualBrand.trim() || null,
          mealType.toLowerCase(),
          servingSize,
          1,
          calories,
          protein,
          carbs,
          fat,
        ]
      );
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
            <Text style={[styles.headerTitle, { color: theme.text }]}>Add Food</Text>
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
                  style={[styles.searchInput, { color: theme.text }]}
                  placeholder="Search Open Food Facts"
                  placeholderTextColor="#888"
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  onSubmitEditing={runSearch}
                  returnKeyType="search"
                />
                <TouchableOpacity onPress={openScanner} style={styles.barcodeBtn}>
                  <Ionicons name="barcode-outline" size={24} color={SAGE} />
                </TouchableOpacity>
              </View>
              <TouchableOpacity style={[styles.searchSubmitBtn, { backgroundColor: SAGE }]} onPress={runSearch}>
                <Text style={styles.searchSubmitText}>Search</Text>
              </TouchableOpacity>
              {searching && <ActivityIndicator size="small" color={SAGE} style={styles.searchSpinner} />}
              <ScrollView style={styles.searchResultsScroll} showsVerticalScrollIndicator={false}>
                {searchResults.map((item) => (
                  <View key={item.code} style={[styles.foodRow, { backgroundColor: theme.card, borderColor: theme.border }]}>
                    <TouchableOpacity
                      style={{ flex: 1 }}
                      activeOpacity={0.6}
                      onPress={() => {
                        setSelectedFood(item);
                        setQtyValue('1');
                        setQtyUnit('serving');
                        setQtyMealType(mealType.charAt(0).toUpperCase() + mealType.slice(1));
                        setShowQuantityModal(true);
                      }}
                    >
                      <View style={styles.foodNameRow}>
                        <Text style={[styles.foodName, { color: theme.text }]}>{item.food_name}</Text>
                        {item.source === 'usda' && (
                          <View style={styles.usdaPill}>
                            <Text style={styles.usdaPillText}>USDA</Text>
                          </View>
                        )}
                      </View>
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
                {!searching && searchQuery.trim() && searchResults.length === 0 && (
                  <View>
                    <Text style={[styles.emptyText, { color: theme.textSecondary }]}>No results. Try another search or scan barcode.</Text>
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
                    <View style={styles.quantityModalActions}>
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
                        <Text style={styles.quantityBtnText}>Add to Log</Text>
                      </TouchableOpacity>
                    </View>
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
                          setQtyValue('1');
                          setQtyUnit('serving');
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
            const live = computedMacros(
              { calories: selectedFood.calories, protein: selectedFood.protein, carbs: selectedFood.carbs, fat: selectedFood.fat },
              quantity || 1,
              qtyUnit
            );
            return (
              <View style={styles.quantityModalOverlay}>
                <View style={[styles.quantityModalBox, { backgroundColor: theme.background }]}>
                  <Text style={[styles.quantityModalTitle, { color: theme.text }]}>{selectedFood.food_name}</Text>
                  <Text style={[styles.quantityModalHint, { color: theme.textSecondary }]}>
                    Per 100g: {selectedFood.calories} cal · P {selectedFood.protein}g · C {selectedFood.carbs}g · F {selectedFood.fat}g
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
                        {UNITS.map((u) => (
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

                  <Text style={[styles.quantityModalLabel, { color: theme.text }]}>Total</Text>
                  <Text style={[styles.quantityModalLive, { color: theme.text }]}>
                    {live.calories} cal · P {live.protein}g · C {live.carbs}g · F {live.fat}g
                  </Text>

                  <View style={styles.quantityModalActions}>
                    <TouchableOpacity style={[styles.quantityBtn, { backgroundColor: theme.card }]} onPress={() => { setShowQuantityModal(false); setSelectedFood(null); setUnitDropdownOpen(false); }}>
                      <Text style={[styles.quantityBtnText, { color: theme.text }]}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.quantityBtn, { backgroundColor: SAGE }]} onPress={handleAddToLog}>
                      <Text style={styles.quantityBtnText}>Add to Log</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            );
          })(          )}
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
  barcodeBtn: { padding: 8 },
  searchSubmitBtn: { paddingVertical: 12, borderRadius: 12, alignItems: 'center', marginBottom: 8 },
  searchSubmitText: { color: '#fff', fontWeight: '600' },
  searchSpinner: { marginVertical: 8 },
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
  foodNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  usdaPill: {
    backgroundColor: '#EAF3EB',
    borderColor: '#C8DFCC',
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
  },
  usdaPillText: { color: '#3E6B44', fontSize: 11, fontWeight: '700' },
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
  quantityModalHint: { fontSize: 14, marginBottom: 12 },
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
  quantityModalLive: { fontSize: 15, fontWeight: '600', marginTop: 4, marginBottom: 16 },
  quantityModalActions: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end' },
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
