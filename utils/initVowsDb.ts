/**
 * Vows and VowCheckIns tables for MyVow feature.
 * Creates/migrates schema — may dedupe legacy duplicate check-ins before adding a unique index.
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
  try {
    await db.runAsync(`ALTER TABLE Vows ADD COLUMN why_text TEXT;`);
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

  // Remove duplicate (vow_id, check_in_date) rows before unique index — EXISTS avoids NOT IN (empty) pitfalls.
  await db.runAsync(`
    DELETE FROM VowCheckIns
    WHERE check_in_id IN (
      SELECT v1.check_in_id FROM VowCheckIns v1
      WHERE EXISTS (
        SELECT 1 FROM VowCheckIns v2
        WHERE v2.vow_id = v1.vow_id
          AND v2.check_in_date = v1.check_in_date
          AND v2.check_in_id < v1.check_in_id
      )
    );
  `);

  try {
    await db.runAsync(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_vow_checkins_unique ON VowCheckIns (vow_id, check_in_date);',
    );
  } catch (e) {
    console.warn('initVowsDb: could not create VowCheckIns unique index', e);
  }
}

export type VowRow = {
  vow_id: number;
  title: string;
  category: string;
  frequency_per_week: number;
  why_text?: string | null;
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
