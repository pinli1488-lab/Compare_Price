import { env } from 'cloudflare:workers';

export type ProductRecord = {
  id: string; sku: string; productName: string; ean: string; ownPriceOre: number; currency: string;
  matchedProductId: string | null; matchedProductName: string | null; matchedProductUrl: string | null;
  matchConfidence: number | null; matchStatus: 'pending' | 'auto' | 'confirmed' | 'not_found';
  lowPriceOre: number | null; lowMerchant: string | null; lowUrl: string | null;
  highPriceOre: number | null; highMerchant: string | null; highUrl: string | null;
  updatedAt: string | null; createdAt: string;
};

let initialized = false;

export function getD1() {
  if (!env.DB) throw new Error('D1 database is unavailable');
  return env.DB;
}

export async function ensureSchema() {
  if (initialized) return;
  const db = getD1();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      sku TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL,
      ean TEXT NOT NULL DEFAULT '',
      own_price_ore INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'SEK',
      matched_product_id TEXT,
      matched_product_name TEXT,
      matched_product_url TEXT,
      match_confidence INTEGER,
      match_status TEXT NOT NULL DEFAULT 'pending',
      low_price_ore INTEGER,
      low_merchant TEXT,
      low_url TEXT,
      high_price_ore INTEGER,
      high_merchant TEXT,
      high_url TEXT,
      updated_at TEXT,
      created_at TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_products_match_status ON products(match_status)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at)'),
  ]);
  initialized = true;
}

export function mapProduct(row: Record<string, unknown>): ProductRecord {
  return {
    id: String(row.id), sku: String(row.sku ?? ''), productName: String(row.product_name), ean: String(row.ean ?? ''),
    ownPriceOre: Number(row.own_price_ore), currency: String(row.currency ?? 'SEK'),
    matchedProductId: row.matched_product_id ? String(row.matched_product_id) : null,
    matchedProductName: row.matched_product_name ? String(row.matched_product_name) : null,
    matchedProductUrl: row.matched_product_url ? String(row.matched_product_url) : null,
    matchConfidence: row.match_confidence == null ? null : Number(row.match_confidence),
    matchStatus: String(row.match_status) as ProductRecord['matchStatus'],
    lowPriceOre: row.low_price_ore == null ? null : Number(row.low_price_ore), lowMerchant: row.low_merchant ? String(row.low_merchant) : null, lowUrl: row.low_url ? String(row.low_url) : null,
    highPriceOre: row.high_price_ore == null ? null : Number(row.high_price_ore), highMerchant: row.high_merchant ? String(row.high_merchant) : null, highUrl: row.high_url ? String(row.high_url) : null,
    updatedAt: row.updated_at ? String(row.updated_at) : null, createdAt: String(row.created_at),
  };
}
