import { SQLiteDatabase } from 'expo-sqlite';

/** DB handle used by meal-plan init and nutrition init — keep minimal for compatibility. */
type SqlMigrationDb = {
  runAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
  getAllAsync: <T>(sql: string, params?: unknown[]) => Promise<T[]>;
};

/**
 * initMealPlansDb creates a minimal MealPlans row; Sage and Nutrition need macro targets and metadata.
 * Safe to call multiple times.
 */
export async function ensureMealPlansNutritionColumns(db: SqlMigrationDb): Promise<void> {
  const alters = [
    `ALTER TABLE MealPlans ADD COLUMN calories_target INTEGER;`,
    `ALTER TABLE MealPlans ADD COLUMN protein_target INTEGER;`,
    `ALTER TABLE MealPlans ADD COLUMN carbs_target INTEGER;`,
    `ALTER TABLE MealPlans ADD COLUMN fat_target INTEGER;`,
    `ALTER TABLE MealPlans ADD COLUMN created_date TEXT;`,
    `ALTER TABLE MealPlans ADD COLUMN prep_guide TEXT;`,
    `ALTER TABLE MealPlans ADD COLUMN grocery_list TEXT;`,
    `ALTER TABLE MealPlans ADD COLUMN week_start TEXT;`,
    `ALTER TABLE MealPlans ADD COLUMN schedule_type TEXT DEFAULT 'manual';`,
  ];
  for (const sql of alters) {
    try {
      await db.runAsync(sql);
    } catch (_) {
      /* column exists */
    }
  }
}

/**
 * Idempotent migration: add LoggedFoods.log_id referencing DailyLog.
 * DailyLog's primary key column is `log_id` (there is no column named `id` on DailyLog).
 * Does not drop or recreate LoggedFoods. Safe on every app start.
 */
export async function migrateLoggedFoodsAddLogIdColumnSafe(
  db: SqlMigrationDb
): Promise<void> {
  const tables = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='LoggedFoods';`
  );
  if (tables.length === 0) return;

  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS DailyLog (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT UNIQUE,
      meal_plan_id INTEGER,
      FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id)
    );
  `);

  try {
    await db.runAsync(
      `ALTER TABLE LoggedFoods ADD COLUMN log_id INTEGER REFERENCES DailyLog(log_id);`
    );
  } catch (_) {
    /* duplicate column name or other benign failure */
  }
}

/**
 * Heals schema drift: initMealPlansDb used to create LoggedFoods with log_date/unit and no log_id,
 * while the nutrition tracker expects DailyLog + LoggedFoods.log_id + serving_size.
 * Safe to call multiple times (idempotent).
 */
export async function ensureLoggedFoodsSchema(db: SqlMigrationDb): Promise<void> {
  const tables = await db.getAllAsync<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='LoggedFoods';`
  );
  if (tables.length === 0) return;

  await migrateLoggedFoodsAddLogIdColumnSafe(db);

  let cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(LoggedFoods);');
  const colNames = () => new Set(cols.map((c) => c.name));
  let names = colNames();
  if (!names.has('serving_size')) {
    try {
      await db.runAsync(`ALTER TABLE LoggedFoods ADD COLUMN serving_size TEXT;`);
    } catch (_) {}
    cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(LoggedFoods);');
    names = colNames();
  }

  if (names.has('unit') && names.has('serving_size')) {
    try {
      await db.runAsync(
        `UPDATE LoggedFoods SET serving_size = unit WHERE serving_size IS NULL AND unit IS NOT NULL;`
      );
    } catch (_) {}
  }

  if (names.has('log_date')) {
    try {
      await db.runAsync(
        `INSERT OR IGNORE INTO DailyLog (log_date) SELECT DISTINCT log_date FROM LoggedFoods WHERE log_date IS NOT NULL;`
      );
    } catch (_) {}
    try {
      await db.runAsync(
        `UPDATE LoggedFoods SET log_id = (SELECT log_id FROM DailyLog WHERE DailyLog.log_date = LoggedFoods.log_date) WHERE log_id IS NULL AND log_date IS NOT NULL;`
      );
    } catch (_) {}
  }

  cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(LoggedFoods);');
  names = colNames();
  if (!names.has('log_date')) return;

  await db.runAsync(`DROP TABLE IF EXISTS LoggedFoods__migr_tmp;`);
  await db.runAsync(`
    CREATE TABLE LoggedFoods__migr_tmp (
      logged_food_id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER,
      food_name TEXT,
      brand TEXT,
      meal_type TEXT,
      serving_size TEXT,
      quantity REAL DEFAULT 1,
      calories INTEGER,
      protein REAL,
      carbs REAL,
      fat REAL,
      FOREIGN KEY (log_id) REFERENCES DailyLog(log_id)
    );
  `);
  const hasUnit = names.has('unit');
  const unitExpr = hasUnit ? 'lf.unit' : 'NULL';
  await db.runAsync(`
    INSERT INTO LoggedFoods__migr_tmp (log_id, food_name, brand, meal_type, serving_size, quantity, calories, protein, carbs, fat)
    SELECT
      COALESCE(lf.log_id, (SELECT d.log_id FROM DailyLog d WHERE d.log_date = lf.log_date LIMIT 1)),
      lf.food_name,
      lf.brand,
      lf.meal_type,
      COALESCE(lf.serving_size, ${unitExpr}, 'serving'),
      lf.quantity,
      lf.calories,
      lf.protein,
      lf.carbs,
      lf.fat
    FROM LoggedFoods lf
    WHERE COALESCE(lf.log_id, (SELECT d.log_id FROM DailyLog d WHERE d.log_date = lf.log_date LIMIT 1)) IS NOT NULL;
  `);
  await db.runAsync(`DROP TABLE LoggedFoods;`);
  await db.runAsync(`ALTER TABLE LoggedFoods__migr_tmp RENAME TO LoggedFoods;`);
}

export async function initNutritionDb(db: SQLiteDatabase): Promise<void> {
  // Create nutrition-related tables if they don't exist
  await db.execAsync(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS MealPlans (
      meal_plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_name TEXT NOT NULL,
      calories_target INTEGER,
      protein_target INTEGER,
      carbs_target INTEGER,
      fat_target INTEGER,
      created_date TEXT,
      prep_guide TEXT,
      grocery_list TEXT
    );

    CREATE TABLE IF NOT EXISTS DayActivePlan (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      meal_plan_id INTEGER NOT NULL,
      UNIQUE(date, meal_plan_id),
      FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS PlannedMeals (
      meal_id INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_plan_id INTEGER,
      meal_name TEXT,
      meal_type TEXT,
      meal_order INTEGER,
      FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id)
    );

    CREATE TABLE IF NOT EXISTS FoodItems (
      food_id INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_id INTEGER,
      food_name TEXT,
      brand TEXT,
      serving_size TEXT,
      calories INTEGER,
      protein REAL,
      carbs REAL,
      fat REAL,
      FOREIGN KEY (meal_id) REFERENCES PlannedMeals(meal_id)
    );

    CREATE TABLE IF NOT EXISTS DailyLog (
      log_id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT UNIQUE,
      meal_plan_id INTEGER,
      FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id)
    );

    CREATE TABLE IF NOT EXISTS LoggedFoods (
      logged_food_id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_id INTEGER,
      food_name TEXT,
      brand TEXT,
      meal_type TEXT,
      serving_size TEXT,
      quantity REAL DEFAULT 1,
      calories INTEGER,
      protein REAL,
      carbs REAL,
      fat REAL,
      FOREIGN KEY (log_id) REFERENCES DailyLog(log_id)
    );

    CREATE TABLE IF NOT EXISTS FavoriteFoods (
      favorite_id INTEGER PRIMARY KEY AUTOINCREMENT,
      food_name TEXT,
      brand TEXT,
      serving_size TEXT,
      calories INTEGER,
      protein REAL,
      carbs REAL,
      fat REAL
    );

    CREATE TABLE IF NOT EXISTS FavoriteWorkouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_name TEXT,
      exercises TEXT
    );

    CREATE TABLE IF NOT EXISTS BodyMetrics (
      metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
      log_date TEXT NOT NULL,
      weight REAL,
      muscle_mass REAL,
      bone_mass REAL,
      body_water REAL,
      body_fat REAL,
      bmi REAL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS StrengthRecords (
      record_id INTEGER PRIMARY KEY AUTOINCREMENT,
      exercise_name TEXT NOT NULL,
      log_date TEXT NOT NULL,
      weight REAL,
      reps INTEGER,
      sets INTEGER,
      one_rep_max REAL
    );
  `);

  // Backfill columns on existing installations
  // Migration: older scheduling schema created MealPlans(name ...) while nutrition uses plan_name.
  try {
    await db.execAsync(`ALTER TABLE MealPlans ADD COLUMN plan_name TEXT;`);
  } catch (e) {
    // ignore if exists
  }
  try {
    await db.execAsync(`ALTER TABLE MealPlans ADD COLUMN name TEXT;`);
  } catch (e) {
    // ignore if exists
  }
  try {
    await db.execAsync(`UPDATE MealPlans SET plan_name = COALESCE(plan_name, name);`);
  } catch (e) {
    // ignore
  }
  try {
    await db.execAsync(`UPDATE MealPlans SET name = COALESCE(name, plan_name);`);
  } catch (e) {
    // ignore
  }

  await ensureMealPlansNutritionColumns(db);
  try {
    await db.execAsync(`ALTER TABLE FoodItems ADD COLUMN quantity REAL DEFAULT 1;`);
  } catch (e) {
    // ignore if exists
  }
  await ensureLoggedFoodsSchema(db);
  await ensureCommonFoodsTable(db);
  await ensurePurchasedItemsTable(db);
}

/**
 * Curated staple foods searched ahead of the USDA API.
 * Schema is additive: only CREATE TABLE IF NOT EXISTS, no ALTERs on this table.
 * Seed runs once when the table is empty (SELECT COUNT(*) gate).
 */
type CommonFoodSeed = {
  name: string;
  search_terms: string;
  serving_size: number;
  serving_unit: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

const COMMON_FOODS_SEED: ReadonlyArray<CommonFoodSeed> = [
  { name: 'Egg, large', search_terms: 'egg,eggs,large egg,whole egg', serving_size: 50, serving_unit: 'g', calories: 72, protein_g: 6.3, carbs_g: 0.4, fat_g: 4.8 },
  { name: 'Egg white, large', search_terms: 'egg white,egg whites,large egg white', serving_size: 33, serving_unit: 'g', calories: 17, protein_g: 3.6, carbs_g: 0.2, fat_g: 0.1 },
  { name: 'Banana, medium', search_terms: 'banana,bananas,medium banana', serving_size: 118, serving_unit: 'g', calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4 },
  { name: 'Apple, medium', search_terms: 'apple,apples,medium apple', serving_size: 182, serving_unit: 'g', calories: 95, protein_g: 0.5, carbs_g: 25, fat_g: 0.3 },
  { name: 'Chicken breast, cooked', search_terms: 'chicken breast,chicken,grilled chicken,cooked chicken breast', serving_size: 100, serving_unit: 'g', calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 },
  { name: 'Ground beef, 85/15, cooked', search_terms: 'ground beef,beef,hamburger meat', serving_size: 100, serving_unit: 'g', calories: 218, protein_g: 26, carbs_g: 0, fat_g: 13 },
  { name: 'Salmon, cooked', search_terms: 'salmon,cooked salmon,baked salmon', serving_size: 100, serving_unit: 'g', calories: 206, protein_g: 22, carbs_g: 0, fat_g: 12 },
  { name: 'Greek yogurt, plain, nonfat', search_terms: 'greek yogurt,yogurt,plain yogurt,nonfat yogurt', serving_size: 170, serving_unit: 'g', calories: 100, protein_g: 17, carbs_g: 6, fat_g: 0.7 },
  { name: 'Milk, 2%', search_terms: 'milk,2% milk,reduced fat milk', serving_size: 240, serving_unit: 'ml', calories: 122, protein_g: 8, carbs_g: 12, fat_g: 4.8 },
  { name: 'Almond milk, unsweetened', search_terms: 'almond milk,unsweetened almond milk', serving_size: 240, serving_unit: 'ml', calories: 30, protein_g: 1, carbs_g: 1, fat_g: 2.5 },
  { name: 'Oatmeal, dry', search_terms: 'oatmeal,oats,rolled oats,dry oats', serving_size: 40, serving_unit: 'g', calories: 150, protein_g: 5, carbs_g: 27, fat_g: 3 },
  { name: 'Brown rice, cooked', search_terms: 'brown rice,cooked rice,rice', serving_size: 158, serving_unit: 'g', calories: 216, protein_g: 5, carbs_g: 45, fat_g: 1.8 },
  { name: 'White rice, cooked', search_terms: 'white rice,cooked white rice', serving_size: 158, serving_unit: 'g', calories: 205, protein_g: 4.3, carbs_g: 45, fat_g: 0.4 },
  { name: 'Quinoa, cooked', search_terms: 'quinoa,cooked quinoa', serving_size: 185, serving_unit: 'g', calories: 222, protein_g: 8, carbs_g: 39, fat_g: 3.6 },
  { name: 'Sweet potato, baked', search_terms: 'sweet potato,baked sweet potato', serving_size: 200, serving_unit: 'g', calories: 180, protein_g: 4, carbs_g: 41, fat_g: 0.3 },
  { name: 'Potato, baked', search_terms: 'potato,baked potato,russet potato', serving_size: 173, serving_unit: 'g', calories: 161, protein_g: 4.3, carbs_g: 37, fat_g: 0.2 },
  { name: 'Avocado', search_terms: 'avocado,avocados,half avocado', serving_size: 100, serving_unit: 'g', calories: 160, protein_g: 2, carbs_g: 9, fat_g: 15 },
  { name: 'Almonds', search_terms: 'almonds,raw almonds', serving_size: 28, serving_unit: 'g', calories: 164, protein_g: 6, carbs_g: 6, fat_g: 14 },
  { name: 'Peanut butter', search_terms: 'peanut butter,pb', serving_size: 32, serving_unit: 'g', calories: 188, protein_g: 8, carbs_g: 7, fat_g: 16 },
  { name: 'Bread, whole wheat', search_terms: 'whole wheat bread,wheat bread,bread', serving_size: 28, serving_unit: 'g', calories: 69, protein_g: 3.6, carbs_g: 12, fat_g: 1 },
  { name: 'Bagel, plain', search_terms: 'bagel,plain bagel', serving_size: 95, serving_unit: 'g', calories: 245, protein_g: 10, carbs_g: 48, fat_g: 1.5 },
  { name: 'Pasta, cooked', search_terms: 'pasta,cooked pasta,spaghetti', serving_size: 140, serving_unit: 'g', calories: 220, protein_g: 8, carbs_g: 43, fat_g: 1.3 },
  { name: 'Cheese, cheddar', search_terms: 'cheddar cheese,cheese,cheddar', serving_size: 28, serving_unit: 'g', calories: 113, protein_g: 7, carbs_g: 0.4, fat_g: 9 },
  { name: 'Cottage cheese, low-fat', search_terms: 'cottage cheese,low fat cottage cheese', serving_size: 113, serving_unit: 'g', calories: 81, protein_g: 14, carbs_g: 3, fat_g: 1.2 },
  { name: 'Butter', search_terms: 'butter,salted butter', serving_size: 14, serving_unit: 'g', calories: 102, protein_g: 0.1, carbs_g: 0, fat_g: 11.5 },
  { name: 'Olive oil', search_terms: 'olive oil,evoo', serving_size: 14, serving_unit: 'ml', calories: 119, protein_g: 0, carbs_g: 0, fat_g: 13.5 },
  { name: 'Broccoli, cooked', search_terms: 'broccoli,cooked broccoli', serving_size: 91, serving_unit: 'g', calories: 31, protein_g: 2.6, carbs_g: 6, fat_g: 0.4 },
  { name: 'Spinach, raw', search_terms: 'spinach,raw spinach,baby spinach', serving_size: 30, serving_unit: 'g', calories: 7, protein_g: 0.9, carbs_g: 1.1, fat_g: 0.1 },
  { name: 'Carrots, raw', search_terms: 'carrots,carrot,raw carrots', serving_size: 128, serving_unit: 'g', calories: 52, protein_g: 1.2, carbs_g: 12, fat_g: 0.3 },
  { name: 'Tomato, medium', search_terms: 'tomato,tomatoes,medium tomato', serving_size: 123, serving_unit: 'g', calories: 22, protein_g: 1.1, carbs_g: 4.8, fat_g: 0.2 },
  { name: 'Lettuce, romaine', search_terms: 'romaine,romaine lettuce,lettuce', serving_size: 47, serving_unit: 'g', calories: 8, protein_g: 0.6, carbs_g: 1.5, fat_g: 0.1 },
  { name: 'Cucumber', search_terms: 'cucumber,cucumbers', serving_size: 100, serving_unit: 'g', calories: 16, protein_g: 0.7, carbs_g: 3.6, fat_g: 0.1 },
  { name: 'Bell pepper', search_terms: 'bell pepper,red pepper,green pepper,pepper', serving_size: 119, serving_unit: 'g', calories: 31, protein_g: 1, carbs_g: 7, fat_g: 0.4 },
  { name: 'Onion', search_terms: 'onion,onions', serving_size: 110, serving_unit: 'g', calories: 44, protein_g: 1.2, carbs_g: 10, fat_g: 0.1 },
  { name: 'Garlic, clove', search_terms: 'garlic,garlic clove', serving_size: 3, serving_unit: 'g', calories: 4, protein_g: 0.2, carbs_g: 1, fat_g: 0 },
  { name: 'Strawberries', search_terms: 'strawberries,strawberry', serving_size: 152, serving_unit: 'g', calories: 49, protein_g: 1, carbs_g: 12, fat_g: 0.5 },
  { name: 'Blueberries', search_terms: 'blueberries,blueberry', serving_size: 148, serving_unit: 'g', calories: 84, protein_g: 1.1, carbs_g: 21, fat_g: 0.5 },
  { name: 'Orange, medium', search_terms: 'orange,oranges,medium orange', serving_size: 131, serving_unit: 'g', calories: 62, protein_g: 1.2, carbs_g: 15, fat_g: 0.2 },
  { name: 'Tuna, canned in water', search_terms: 'tuna,canned tuna,tuna in water', serving_size: 85, serving_unit: 'g', calories: 99, protein_g: 22, carbs_g: 0, fat_g: 0.7 },
  { name: 'Shrimp, cooked', search_terms: 'shrimp,cooked shrimp', serving_size: 85, serving_unit: 'g', calories: 84, protein_g: 18, carbs_g: 0.2, fat_g: 0.9 },
  { name: 'Tofu, firm', search_terms: 'tofu,firm tofu', serving_size: 100, serving_unit: 'g', calories: 144, protein_g: 17, carbs_g: 3, fat_g: 9 },
  { name: 'Black beans, cooked', search_terms: 'black beans,cooked black beans', serving_size: 172, serving_unit: 'g', calories: 227, protein_g: 15, carbs_g: 41, fat_g: 0.9 },
  { name: 'Chickpeas, cooked', search_terms: 'chickpeas,garbanzo beans,cooked chickpeas', serving_size: 164, serving_unit: 'g', calories: 269, protein_g: 15, carbs_g: 45, fat_g: 4.2 },
  { name: 'Lentils, cooked', search_terms: 'lentils,cooked lentils', serving_size: 198, serving_unit: 'g', calories: 230, protein_g: 18, carbs_g: 40, fat_g: 0.8 },
  { name: 'Hummus', search_terms: 'hummus', serving_size: 30, serving_unit: 'g', calories: 71, protein_g: 2.4, carbs_g: 6, fat_g: 4.1 },
  { name: 'Honey', search_terms: 'honey', serving_size: 21, serving_unit: 'g', calories: 64, protein_g: 0.1, carbs_g: 17, fat_g: 0 },
  { name: 'Maple syrup', search_terms: 'maple syrup,syrup', serving_size: 20, serving_unit: 'ml', calories: 52, protein_g: 0, carbs_g: 13, fat_g: 0 },
  { name: 'Coffee, black', search_terms: 'coffee,black coffee', serving_size: 240, serving_unit: 'ml', calories: 2, protein_g: 0.3, carbs_g: 0, fat_g: 0 },
  { name: 'Protein powder, whey', search_terms: 'protein powder,whey protein,whey', serving_size: 30, serving_unit: 'g', calories: 120, protein_g: 24, carbs_g: 3, fat_g: 1.5 },
  { name: 'Dark chocolate, 70%', search_terms: 'dark chocolate,chocolate', serving_size: 28, serving_unit: 'g', calories: 170, protein_g: 2.2, carbs_g: 13, fat_g: 12 },
];

export async function ensureCommonFoodsTable(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS CommonFoods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      search_terms TEXT NOT NULL,
      serving_size REAL NOT NULL,
      serving_unit TEXT NOT NULL,
      calories REAL NOT NULL,
      protein_g REAL NOT NULL,
      carbs_g REAL NOT NULL,
      fat_g REAL NOT NULL,
      fiber_g REAL DEFAULT 0,
      sugar_g REAL DEFAULT 0,
      sodium_mg REAL DEFAULT 0,
      source TEXT DEFAULT 'curated'
    );
  `);

  try {
    const countRows = await db.getAllAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM CommonFoods;'
    );
    const existing = Number(countRows?.[0]?.c ?? 0);
    if (existing > 0) return;
  } catch (_) {
    return;
  }

  for (const f of COMMON_FOODS_SEED) {
    try {
      await db.runAsync(
        `INSERT INTO CommonFoods (name, search_terms, serving_size, serving_unit, calories, protein_g, carbs_g, fat_g) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          f.name,
          f.search_terms.toLowerCase(),
          f.serving_size,
          f.serving_unit,
          f.calories,
          f.protein_g,
          f.carbs_g,
          f.fat_g,
        ],
      );
    } catch (e) {
      console.log('CommonFoods seed insert failed:', f.name, e);
    }
  }
}

/**
 * Receipt-derived purchase history. Each row tracks a product the user has bought,
 * with running purchase_count and first_seen / last_purchased ISO date strings.
 * Schema is additive: only CREATE TABLE IF NOT EXISTS. No seed, no indexes (yet).
 */
export async function ensurePurchasedItemsTable(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS PurchasedItems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand TEXT,
      product TEXT NOT NULL,
      category TEXT,
      store TEXT,
      purchase_count INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_purchased TEXT NOT NULL
    );
  `);
}

