/**
 * PurchasedProducts: full product lines learned from Sage receipt photos (SQLite).
 */
import type { SQLiteDatabase } from 'expo-sqlite';
import { stripMarkdownFromVowText } from './sageMarkdownStrip';

export async function initPurchasedProductsDb(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DROP TABLE IF EXISTS PurchasedBrands;');
  await db.runAsync(`
    CREATE TABLE IF NOT EXISTS PurchasedProducts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      count INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);
}

export async function upsertProduct(db: SQLiteDatabase, productName: string): Promise<void> {
  await initPurchasedProductsDb(db);
  const now = new Date().toISOString();
  const trimmed = productName.trim();
  if (!trimmed) return;
  await db.runAsync(
    `INSERT INTO PurchasedProducts (product_name, count, first_seen_at, last_seen_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(product_name) DO UPDATE SET
       count = count + 1,
       last_seen_at = excluded.last_seen_at`,
    [trimmed, now, now],
  );
}

export async function getTopProducts(db: SQLiteDatabase, limit = 20): Promise<string[]> {
  await initPurchasedProductsDb(db);
  const rows = await db.getAllAsync<{ product_name: string }>(
    'SELECT product_name FROM PurchasedProducts ORDER BY count DESC, last_seen_at DESC LIMIT ?',
    [limit],
  );
  return rows.map((r) => r.product_name);
}

export async function removeProduct(db: SQLiteDatabase, productName: string): Promise<void> {
  await initPurchasedProductsDb(db);
  const trimmed = productName.trim();
  if (!trimmed) return;
  await db.runAsync('DELETE FROM PurchasedProducts WHERE product_name = ? COLLATE NOCASE', [trimmed]);
}

export async function isProductInPurchasedTable(
  db: SQLiteDatabase,
  productName: string,
): Promise<boolean> {
  await initPurchasedProductsDb(db);
  const t = productName.trim();
  if (!t) return false;
  const rows = await db.getAllAsync<{ n: number }>(
    'SELECT 1 as n FROM PurchasedProducts WHERE product_name = ? COLLATE NOCASE LIMIT 1',
    [t],
  );
  return rows.length > 0;
}

export async function areAllProductsInPurchasedTable(
  db: SQLiteDatabase,
  names: string[],
): Promise<boolean> {
  if (names.length === 0) return false;
  for (const n of names) {
    if (!(await isProductInPurchasedTable(db, n))) return false;
  }
  return true;
}

/** Strip all <products> blocks from assistant text for bubble display. */
export function stripProductsTagsFromMessage(content: string): string {
  return content
    .replace(/<products>[\s\S]*?<\/products>/gi, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Parse comma-separated product names from all <products>...</products> segments.
 * Dedupes case-insensitively; max 20 per message.
 */
export function parseProductsTagNamesFromContent(raw: string): string[] {
  const out: string[] = [];
  const seenLc = new Set<string>();
  const re = /<products>([\s\S]*?)<\/products>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const inner = stripMarkdownFromVowText(m[1].replace(/\s+/g, ' '));
    const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const lc = p.toLowerCase();
      if (seenLc.has(lc)) continue;
      seenLc.add(lc);
      out.push(p);
      if (out.length >= 20) return out;
    }
  }
  return out;
}
