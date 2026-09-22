import { env } from 'cloudflare:workers';
import { COUNTRIES, COUNTRY_CODES, type CountryCode } from '@/lib/countries';

export type MatchStatus = 'pending' | 'auto' | 'confirmed' | 'not_found';
export type CountryPriceRecord = {
  country: CountryCode; currency: string;
  mistoreHandle: string | null; mistoreName: string | null; mistoreUrl: string | null; mistorePriceMinor: number | null;
  marketProductId: string | null; marketProductName: string | null; marketProductUrl: string | null;
  matchConfidence: number | null; matchStatus: MatchStatus;
  lowPriceMinor: number | null; lowMerchant: string | null; lowUrl: string | null;
  secondLowPriceMinor: number | null; secondLowMerchant: string | null;
  expectedPriceMinor: number | null; updatedAt: string | null; manualRefreshedAt: string | null; autoRefreshedAt: string | null;
};
export type ProductVariant = { sku: string; ean: string; title: string; priceMinor: number };
export type LarkCostRecord = {
  sku: string; recordId: string; status: 'ok' | 'duplicate'; costSekMinor: number | null;
  warehouseSekMinor: number | null; seLogisticsSekMinor: number | null; dkLogisticsSekMinor: number | null;
  fiLogisticsSekMinor: number | null; noLogisticsSekMinor: number | null; chemicalTaxSeSekMinor: number | null;
  copySweSekMinor: number | null; copyDkSekMinor: number | null; fixedFeeSekMinor: number | null;
  rabattSekMinor: number | null; updatedAt: string;
};
export type ProductRecord = {
  id: string; sku: string; productName: string; ean: string; createdAt: string;
  markets: Record<CountryCode, CountryPriceRecord>; variants: Record<CountryCode, ProductVariant[]>; larkCosts: Record<string, LarkCostRecord>;
};

let initialized = false;
export function getD1() { if (!env.DB) throw new Error('D1 database is unavailable'); return env.DB; }

export async function ensureSchema() {
  if (initialized) return;
  const db = getD1();
  const countryPriceColumns = await db.prepare('PRAGMA table_info(product_country_prices)').all();
  const existingColumns = new Set(countryPriceColumns.results.map((row) => String(row.name)));
  if (countryPriceColumns.results.length && !existingColumns.has('second_low_price_minor')) {
    await db.prepare('ALTER TABLE product_country_prices ADD COLUMN second_low_price_minor INTEGER').run();
  }
  if (countryPriceColumns.results.length && !existingColumns.has('second_low_merchant')) {
    await db.prepare('ALTER TABLE product_country_prices ADD COLUMN second_low_merchant TEXT').run();
  }
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL DEFAULT '', product_name TEXT NOT NULL, ean TEXT NOT NULL DEFAULT '',
      own_price_ore INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'SEK', matched_product_id TEXT,
      matched_product_name TEXT, matched_product_url TEXT, match_confidence INTEGER, match_status TEXT NOT NULL DEFAULT 'pending',
      low_price_ore INTEGER, low_merchant TEXT, low_url TEXT, high_price_ore INTEGER, high_merchant TEXT, high_url TEXT,
      updated_at TEXT, created_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS product_country_prices (
      product_id TEXT NOT NULL, country TEXT NOT NULL, currency TEXT NOT NULL,
      mistore_handle TEXT, mistore_name TEXT, mistore_url TEXT, mistore_price_minor INTEGER,
      market_product_id TEXT, market_product_name TEXT, market_product_url TEXT,
      match_confidence INTEGER, match_status TEXT NOT NULL DEFAULT 'pending',
      low_price_minor INTEGER, low_merchant TEXT, low_url TEXT,
      second_low_price_minor INTEGER, second_low_merchant TEXT,
      expected_price_minor INTEGER, updated_at TEXT,
      PRIMARY KEY (product_id, country)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS product_variants (
      product_id TEXT NOT NULL, country TEXT NOT NULL, variants_json TEXT NOT NULL,
      PRIMARY KEY (product_id, country)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS price_refresh_log (
      product_id TEXT NOT NULL, country TEXT NOT NULL, manual_at TEXT, auto_at TEXT,
      PRIMARY KEY (product_id, country)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS selected_collections (
      handle TEXT PRIMARY KEY, title TEXT NOT NULL, product_handles_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS lark_product_costs (
      record_id TEXT PRIMARY KEY, sku TEXT NOT NULL, sku_normalized TEXT NOT NULL,
      cost_sek_minor INTEGER, warehouse_sek_minor INTEGER,
      se_logistics_sek_minor INTEGER, dk_logistics_sek_minor INTEGER, fi_logistics_sek_minor INTEGER, no_logistics_sek_minor INTEGER,
      chemical_tax_se_sek_minor INTEGER, copy_swe_sek_minor INTEGER, copy_dk_sek_minor INTEGER,
      fixed_fee_sek_minor INTEGER, rabatt_sek_minor INTEGER, updated_at TEXT NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS integration_status (
      integration TEXT PRIMARY KEY, last_synced_at TEXT, last_error TEXT
    )`),
    db.prepare(`INSERT OR IGNORE INTO product_country_prices (
      product_id,country,currency,market_product_id,market_product_name,market_product_url,
      match_confidence,match_status
    ) SELECT id,'SE','SEK',matched_product_id,matched_product_name,matched_product_url,
      match_confidence,match_status FROM products`),
    db.prepare(`UPDATE product_country_prices SET low_price_minor=NULL, low_merchant=NULL, low_url=NULL, updated_at=NULL
      WHERE mistore_handle IS NULL AND (low_price_minor IS NOT NULL OR low_merchant IS NOT NULL OR low_url IS NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_country_prices_updated ON product_country_prices(updated_at)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_country_prices_status ON product_country_prices(match_status)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_lark_costs_sku ON lark_product_costs(sku_normalized)'),
  ]);
  initialized = true;
}

export function emptyCountryPrice(country: CountryCode): CountryPriceRecord {
  return {
    country, currency: COUNTRIES[country].currency,
    mistoreHandle: null, mistoreName: null, mistoreUrl: null, mistorePriceMinor: null,
    marketProductId: null, marketProductName: null, marketProductUrl: null,
    matchConfidence: null, matchStatus: 'pending', lowPriceMinor: null, lowMerchant: null, lowUrl: null,
    secondLowPriceMinor: null, secondLowMerchant: null,
    expectedPriceMinor: null, updatedAt: null, manualRefreshedAt: null, autoRefreshedAt: null,
  };
}

export function mapCountryPrice(row: Record<string, unknown>): CountryPriceRecord {
  const country = String(row.country) as CountryCode;
  return {
    country, currency: String(row.currency ?? COUNTRIES[country].currency),
    mistoreHandle: row.mistore_handle ? String(row.mistore_handle) : null,
    mistoreName: row.mistore_name ? String(row.mistore_name) : null,
    mistoreUrl: row.mistore_url ? String(row.mistore_url) : null,
    mistorePriceMinor: row.mistore_price_minor == null ? null : Number(row.mistore_price_minor),
    marketProductId: row.market_product_id ? String(row.market_product_id) : null,
    marketProductName: row.market_product_name ? String(row.market_product_name) : null,
    marketProductUrl: row.market_product_url ? String(row.market_product_url) : null,
    matchConfidence: row.match_confidence == null ? null : Number(row.match_confidence),
    matchStatus: String(row.match_status ?? 'pending') as MatchStatus,
    lowPriceMinor: row.low_price_minor == null ? null : Number(row.low_price_minor),
    lowMerchant: row.low_merchant ? String(row.low_merchant) : null,
    lowUrl: row.low_url ? String(row.low_url) : null,
    secondLowPriceMinor: row.second_low_price_minor == null ? null : Number(row.second_low_price_minor),
    secondLowMerchant: row.second_low_merchant ? String(row.second_low_merchant) : null,
    expectedPriceMinor: row.expected_price_minor == null ? null : Number(row.expected_price_minor),
    updatedAt: row.updated_at ? String(row.updated_at) : null,
    manualRefreshedAt: row.manual_at ? String(row.manual_at) : null,
    autoRefreshedAt: row.auto_at ? String(row.auto_at) : null,
  };
}

export function mapProducts(productRows: Record<string, unknown>[], countryRows: Record<string, unknown>[], variantRows: Record<string, unknown>[] = [], costRows: Record<string, unknown>[] = []): ProductRecord[] {
  const countriesByProduct = new Map<string, Record<CountryCode, CountryPriceRecord>>();
  const variantsByProduct = new Map<string, Record<CountryCode, ProductVariant[]>>();
  for (const row of variantRows) {
    const country = String(row.country) as CountryCode;
    if (!COUNTRY_CODES.includes(country)) continue;
    try {
      const variants = variantsByProduct.get(String(row.product_id)) ?? Object.fromEntries(COUNTRY_CODES.map((code) => [code, []])) as unknown as Record<CountryCode, ProductVariant[]>;
      variants[country] = JSON.parse(String(row.variants_json)) as ProductVariant[];
      variantsByProduct.set(String(row.product_id), variants);
    } catch { /* Ignore invalid historic metadata. */ }
  }
  for (const row of countryRows) {
    const productId = String(row.product_id); const country = String(row.country) as CountryCode;
    if (!COUNTRY_CODES.includes(country)) continue;
    const markets = countriesByProduct.get(productId) ?? Object.fromEntries(COUNTRY_CODES.map((code) => [code, emptyCountryPrice(code)])) as Record<CountryCode, CountryPriceRecord>;
    markets[country] = mapCountryPrice(row); countriesByProduct.set(productId, markets);
  }
  const costGroups = new Map<string, Record<string, unknown>[]>();
  for (const row of costRows) {
    const normalized = String(row.sku_normalized ?? '');
    const group = costGroups.get(normalized) ?? []; group.push(row); costGroups.set(normalized, group);
  }
  const mapCosts = (skus: string[]) => Object.fromEntries(skus.flatMap((sku) => {
    const normalized = sku.trim().toLowerCase(); if (!normalized) return [];
    const rows = costGroups.get(normalized) ?? []; if (!rows.length) return [];
    const row = rows[0]; const minor = (name: string) => row[name] == null ? null : Number(row[name]);
    return [[normalized, {
      sku, recordId: String(row.record_id), status: rows.length > 1 ? 'duplicate' : 'ok', costSekMinor: minor('cost_sek_minor'),
      warehouseSekMinor: minor('warehouse_sek_minor'), seLogisticsSekMinor: minor('se_logistics_sek_minor'),
      dkLogisticsSekMinor: minor('dk_logistics_sek_minor'), fiLogisticsSekMinor: minor('fi_logistics_sek_minor'),
      noLogisticsSekMinor: minor('no_logistics_sek_minor'), chemicalTaxSeSekMinor: minor('chemical_tax_se_sek_minor'),
      copySweSekMinor: minor('copy_swe_sek_minor'), copyDkSekMinor: minor('copy_dk_sek_minor'),
      fixedFeeSekMinor: minor('fixed_fee_sek_minor'), rabattSekMinor: minor('rabatt_sek_minor'), updatedAt: String(row.updated_at),
    } satisfies LarkCostRecord]];
  }));
  return productRows.map((row) => {
    const productId = String(row.id);
    const variants = variantsByProduct.get(productId) ?? Object.fromEntries(COUNTRY_CODES.map((code) => [code, []])) as unknown as Record<CountryCode, ProductVariant[]>;
    const skus = [String(row.sku ?? ''), ...COUNTRY_CODES.flatMap((country) => variants[country].map((variant) => variant.sku))];
    return ({
    id: String(row.id), sku: String(row.sku ?? ''), productName: String(row.product_name), ean: String(row.ean ?? ''), createdAt: String(row.created_at),
    markets: countriesByProduct.get(productId) ?? Object.fromEntries(COUNTRY_CODES.map((code) => [code, emptyCountryPrice(code)])) as Record<CountryCode, CountryPriceRecord>,
    variants, larkCosts: mapCosts(skus),
  }); });
}

export async function saveVariants(productId: string, country: CountryCode, variants: ProductVariant[]) {
  await getD1().prepare(`INSERT INTO product_variants(product_id,country,variants_json) VALUES(?,?,?)
    ON CONFLICT(product_id,country) DO UPDATE SET variants_json=excluded.variants_json`)
    .bind(productId, country, JSON.stringify(variants)).run();
}

export async function recordRefresh(productId: string, country: CountryCode, source: 'manual' | 'auto', timestamp: string) {
  const column = source === 'auto' ? 'auto_at' : 'manual_at';
  await getD1().prepare(`INSERT INTO price_refresh_log(product_id,country,${column}) VALUES(?,?,?)
    ON CONFLICT(product_id,country) DO UPDATE SET ${column}=excluded.${column}`)
    .bind(productId, country, timestamp).run();
}

export async function getProduct(id: string) {
  const result = await getD1().prepare('SELECT id, sku, product_name, ean, created_at FROM products WHERE id = ?').bind(id).first();
  return result ? { id: String(result.id), sku: String(result.sku ?? ''), productName: String(result.product_name), ean: String(result.ean ?? ''), createdAt: String(result.created_at) } : null;
}

export async function upsertCountryPrice(productId: string, value: CountryPriceRecord) {
  await getD1().prepare(`INSERT INTO product_country_prices (
    product_id,country,currency,mistore_handle,mistore_name,mistore_url,mistore_price_minor,
    market_product_id,market_product_name,market_product_url,match_confidence,match_status,
    low_price_minor,low_merchant,low_url,second_low_price_minor,second_low_merchant,expected_price_minor,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id,country) DO UPDATE SET
    currency=excluded.currency,mistore_handle=excluded.mistore_handle,mistore_name=excluded.mistore_name,
    mistore_url=excluded.mistore_url,mistore_price_minor=excluded.mistore_price_minor,
    market_product_id=excluded.market_product_id,market_product_name=excluded.market_product_name,
    market_product_url=excluded.market_product_url,match_confidence=excluded.match_confidence,match_status=excluded.match_status,
    low_price_minor=excluded.low_price_minor,low_merchant=excluded.low_merchant,low_url=excluded.low_url,
    second_low_price_minor=excluded.second_low_price_minor,second_low_merchant=excluded.second_low_merchant,
    expected_price_minor=excluded.expected_price_minor,updated_at=excluded.updated_at`)
    .bind(productId, value.country, value.currency, value.mistoreHandle, value.mistoreName, value.mistoreUrl, value.mistorePriceMinor,
      value.marketProductId, value.marketProductName, value.marketProductUrl, value.matchConfidence, value.matchStatus,
      value.lowPriceMinor, value.lowMerchant, value.lowUrl, value.secondLowPriceMinor, value.secondLowMerchant,
      value.expectedPriceMinor, value.updatedAt).run();
}
