import { SQLiteDatabase } from 'expo-sqlite';

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
  try {
    await db.execAsync(`
      ALTER TABLE MealPlans ADD COLUMN prep_guide TEXT;
    `);
  } catch (e) {
    // Ignore error if column already exists
    console.log('MealPlans.prep_guide may already exist:', e);
  }

  try {
    await db.execAsync(`
      ALTER TABLE MealPlans ADD COLUMN grocery_list TEXT;
    `);
  } catch (e) {
    console.log('MealPlans.grocery_list may already exist:', e);
  }

  try {
    await db.execAsync(`
      ALTER TABLE MealPlans ADD COLUMN week_start TEXT;
    `);
  } catch (e) {
    console.log('MealPlans.week_start may already exist:', e);
  }
}

