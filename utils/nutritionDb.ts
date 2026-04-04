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
}

