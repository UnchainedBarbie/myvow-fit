/**
 * Vows and VowCheckIns tables for MyVow feature.
 */
export async function initVowsDb(db: {
  runAsync: (sql: string, params?: (string | number | null)[]) => Promise<void>;
  getAllAsync: (sql: string, params?: (string | number | null)[]) => Promise<any[]>;
}) {
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS Vows (
      vow_id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'custom',
      frequency_per_week INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      broken_at TEXT
    );
  `);
  // Backwards-compatible migration: add frequency_per_week if it doesn't exist
  try {
    await db.runAsync(`ALTER TABLE Vows ADD COLUMN frequency_per_week INTEGER NOT NULL DEFAULT 3;`);
  } catch {
    // ignore if column already exists
  }
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS VowCheckIns (
      check_in_id INTEGER PRIMARY KEY AUTOINCREMENT,
      vow_id INTEGER NOT NULL,
      check_in_date TEXT NOT NULL,
      kept INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (vow_id) REFERENCES Vows(vow_id) ON DELETE CASCADE
    );
  `);
}

export type VowRow = {
  vow_id: number;
  title: string;
  category: string;
  frequency_per_week: number;
  status: string;
  created_at: string;
  completed_at: string | null;
  broken_at: string | null;
};

export type VowCheckInRow = {
  check_in_id: number;
  vow_id: number;
  check_in_date: string;
  kept: number;
  note: string | null;
  created_at: string;
};
