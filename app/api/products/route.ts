import { ensureSchema, getD1, mapProducts } from '@/db/store';
import { isCountryCode } from '@/lib/countries';
import { isLarkConfigured, writeExpectedPrices } from '@/lib/lark';

export const runtime = 'edge';

export async function GET() {
  await ensureSchema();
  const [products, prices, variants, costs, larkStatus] = await Promise.all([
    getD1().prepare('SELECT id,sku,product_name,ean,created_at FROM products ORDER BY created_at ASC, rowid ASC').all(),
    getD1().prepare(`SELECT p.*, l.manual_at, l.auto_at FROM product_country_prices p
      LEFT JOIN price_refresh_log l ON l.product_id=p.product_id AND l.country=p.country`).all(),
    getD1().prepare('SELECT * FROM product_variants').all(),
    getD1().prepare('SELECT * FROM lark_product_costs').all(),
    getD1().prepare("SELECT last_synced_at,last_error FROM integration_status WHERE integration='lark'").first(),
  ]);
  return Response.json({
    products: mapProducts(products.results as Record<string, unknown>[], prices.results as Record<string, unknown>[], variants.results as Record<string, unknown>[], costs.results as Record<string, unknown>[]),
    lark: { configured: isLarkConfigured(), lastSyncedAt: larkStatus?.last_synced_at ?? null, lastError: larkStatus?.last_error ?? null },
  });
}

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as { products?: Array<{ sku?: string; productName?: string; ean?: string }> };
  if ((body.products ?? []).length > 30) return Response.json({ error: 'Import up to 30 products per request' }, { status: 400 });
  const rows = (body.products ?? []).map((item) => ({
    sku: String(item.sku ?? '').trim(), productName: String(item.productName ?? '').trim(), ean: String(item.ean ?? '').trim(),
  })).filter((item) => item.sku || item.productName || item.ean);
  if (!rows.length) return Response.json({ error: 'Enter at least a SKU, product name, or EAN' }, { status: 400 });
  const existing = await getD1().prepare('SELECT id,sku,ean FROM products').all();
  const bySku = new Map<string, string>(); const byEan = new Map<string, string>();
  for (const row of existing.results) {
    if (String(row.sku ?? '').trim()) bySku.set(String(row.sku).trim().toLowerCase(), String(row.id));
    if (String(row.ean ?? '').trim()) byEan.set(String(row.ean).trim().toLowerCase(), String(row.id));
  }
  const now = new Date().toISOString(); const ids: string[] = []; const touchedIds: string[] = []; let updated = 0;
  const statements = rows.map((item) => {
    const existingId = (item.sku && bySku.get(item.sku.toLowerCase())) || (item.ean && byEan.get(item.ean.toLowerCase()));
    if (existingId) {
      updated += 1;
      touchedIds.push(existingId);
      return getD1().prepare(`UPDATE products SET sku=CASE WHEN ?<>'' THEN ? ELSE sku END,
        ean=CASE WHEN ?<>'' THEN ? ELSE ean END, product_name=CASE WHEN ?<>'' THEN ? ELSE product_name END WHERE id=?`)
        .bind(item.sku, item.sku, item.ean, item.ean, item.productName, item.productName, existingId);
    }
    const id = crypto.randomUUID(); ids.push(id); touchedIds.push(id);
    if (item.sku) bySku.set(item.sku.toLowerCase(), id);
    if (item.ean) byEan.set(item.ean.toLowerCase(), id);
    return getD1().prepare(`INSERT INTO products
    (id,sku,product_name,ean,own_price_ore,currency,match_status,created_at) VALUES (?,?,?,?,0,'SEK','pending',?)`)
    .bind(id, item.sku, item.productName || item.sku || item.ean, item.ean, now);
  });
  for (let index = 0; index < statements.length; index += 80) await getD1().batch(statements.slice(index, index + 80));
  return Response.json({ imported: ids.length, updated, ids, touchedIds: [...new Set(touchedIds)] });
}

export async function PATCH(request: Request) {
  await ensureSchema();
  const body = await request.json() as { id?: string; country?: string; expectedPriceMinor?: number | null; skus?: string[] };
  if (!body.id || !isCountryCode(body.country)) return Response.json({ error: 'Invalid product or country' }, { status: 400 });
  const value = body.expectedPriceMinor == null ? null : Math.round(Number(body.expectedPriceMinor));
  if (value != null && (!Number.isFinite(value) || value < 0)) return Response.json({ error: 'Invalid expected price' }, { status: 400 });
  let larkWriteback: 'saved' | 'not_connected' | 'no_matching_sku' | 'partial' = 'not_connected';
  let writebackErrors: string[] = [];
  let larkWritebackCount = 0;
  if (isLarkConfigured()) {
    const normalized = [...new Set((body.skus ?? []).map((sku) => sku.trim().toLowerCase()).filter(Boolean))];
    if (normalized.length) {
      const placeholders = normalized.map(() => '?').join(',');
      const records = await getD1().prepare(`SELECT record_id FROM lark_product_costs WHERE sku_normalized IN (${placeholders})`).bind(...normalized).all();
      if (records.results.length) {
        const results = await writeExpectedPrices(body.country, value, records.results.map((row) => String(row.record_id)));
        larkWritebackCount = results.filter((result) => result.ok).length;
        writebackErrors = results.filter((result) => !result.ok).map((result) => result.error ?? result.recordId);
        larkWriteback = writebackErrors.length ? 'partial' : 'saved';
      } else larkWriteback = 'no_matching_sku';
    } else larkWriteback = 'no_matching_sku';
  }
  await getD1().prepare(`INSERT INTO product_country_prices (product_id,country,currency,expected_price_minor)
    VALUES (?,?,?,?) ON CONFLICT(product_id,country) DO UPDATE SET expected_price_minor=excluded.expected_price_minor`)
    .bind(body.id, body.country, body.country === 'FI' ? 'EUR' : body.country === 'DK' ? 'DKK' : body.country === 'NO' ? 'NOK' : 'SEK', value).run();
  return Response.json({ saved: true, larkWriteback, larkWritebackCount, writebackErrors });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const { ids } = await request.json() as { ids?: string[] };
  if ((ids ?? []).length > 10) return Response.json({ error: 'Delete up to 10 products per request' }, { status: 400 });
  const safeIds = ids ?? [];
  if (!safeIds.length) return Response.json({ deleted: 0 });
  const statements = safeIds.flatMap((id) => [
    getD1().prepare('DELETE FROM product_country_prices WHERE product_id = ?').bind(id),
    getD1().prepare('DELETE FROM product_variants WHERE product_id = ?').bind(id),
    getD1().prepare('DELETE FROM price_refresh_log WHERE product_id = ?').bind(id),
    getD1().prepare('DELETE FROM products WHERE id = ?').bind(id),
  ]);
  for (let index = 0; index < statements.length; index += 80) await getD1().batch(statements.slice(index, index + 80));
  return Response.json({ deleted: safeIds.length });
}
