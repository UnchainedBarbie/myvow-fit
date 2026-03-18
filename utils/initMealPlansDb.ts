/**
 * Meal plans and schedule tables. Call from Nutrition screens (under SQLiteProvider).
 */
export const initMealPlansDb = async (db: {
  runAsync: (sql: string, params?: any[]) => Promise<void>;
  getAllAsync: (sql: string, params?: any[]) => Promise<any[]>;
}) => {
  try {
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS MealPlans (
        meal_plan_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        schedule_type TEXT DEFAULT 'manual'
      );
    `);
    try {
      await db.runAsync(`ALTER TABLE MealPlans ADD COLUMN schedule_type TEXT DEFAULT 'manual';`);
    } catch (_) {
      // Column may already exist
    }
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS MealPlanSchedule (
        schedule_id INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_plan_id INTEGER NOT NULL,
        day_of_week TEXT NOT NULL,
        FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id) ON DELETE CASCADE
      );
    `);
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS MealPlanItems (
        item_id INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_plan_id INTEGER NOT NULL,
        food_name TEXT NOT NULL,
        meal_type TEXT,
        sort_order INTEGER DEFAULT 0,
        FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id) ON DELETE CASCADE
      );
    `);
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS FoodLogEntry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_date TEXT NOT NULL,
        food_name TEXT NOT NULL,
        meal_type TEXT,
        meal_plan_id INTEGER,
        FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id)
      );
    `);
    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS DayActivePlan (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        meal_plan_id INTEGER NOT NULL,
        UNIQUE(date, meal_plan_id),
        FOREIGN KEY (meal_plan_id) REFERENCES MealPlans(meal_plan_id) ON DELETE CASCADE
      );
    `);

    await db.runAsync(`
      CREATE TABLE IF NOT EXISTS LoggedFoods (
        logged_food_id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_date TEXT NOT NULL,
        meal_type TEXT,
        food_name TEXT NOT NULL,
        brand TEXT,
        quantity REAL DEFAULT 1,
        unit TEXT DEFAULT 'serving',
        calories REAL DEFAULT 0,
        protein REAL DEFAULT 0,
        carbs REAL DEFAULT 0,
        fat REAL DEFAULT 0
      );
    `);
  } catch (error) {
    console.error('initMealPlansDb error:', error);
  }
};

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayOfWeek = (typeof DAYS)[number];

export function getTodayDayOfWeek(): DayOfWeek {
  const d = new Date().getDay();
  return DAYS[d];
}

export const WEEKDAY_DAYS: DayOfWeek[] = ['mon', 'tue', 'wed', 'thu', 'fri'];
export const WEEKEND_DAYS: DayOfWeek[] = ['sat', 'sun'];
/** Alternating A = odd days: mon, wed, fri, sun. B = even: tue, thu, sat. */
export const ALTERNATING_A_DAYS: DayOfWeek[] = ['mon', 'wed', 'fri', 'sun'];
export const ALTERNATING_B_DAYS: DayOfWeek[] = ['tue', 'thu', 'sat'];

export function isAlternatingA(day: DayOfWeek): boolean {
  return ALTERNATING_A_DAYS.includes(day);
}
export function isAlternatingB(day: DayOfWeek): boolean {
  return ALTERNATING_B_DAYS.includes(day);
}
