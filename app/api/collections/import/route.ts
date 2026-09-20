import { ensureSchema, getD1 } from '@/db/store';
import { fetchMiStoreProduct } from '@/lib/mistore';

export const runtime = 'edge';

const BATCH_SIZE = 8;

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as { handle?: string; offset?: number; handles?: string[] };
  const handle = String(body.handle ?? '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(handle)) return Response.json({ error: 'Invalid collection handle' }, { status: 400 });
  const saved = await getD1().prepare('SELECT product_handles_json FROM selected_collections WHERE handle=?').bind(handle).first();
  if (!saved) return Response.json({ error: 'Add this collection before importing its products' }, { status: 404 });
  const allHandles = JSON.parse(String(saved.product_handles_json)) as string[];
  const allowed = new Set(allHandles);
  const offset = Number(body.offset ?? 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > allHandles.length) return Response.json({ error: 'Invalid import offset' }, { status: 400 });
  const selected = body.handles ?? allHandles.slice(offset, offset + BATCH_SIZE);
  if (!Array.isArray(selected) || selected.length > BATCH_SIZE || selected.some((item) => typeof item !== 'string' || !allowed.has(item))) {
    return Response.json({ error: 'Import up to eight products from the selected collection' }, { status: 400 });
  }
  if (!selected.length) return Response.json({ processed: 0, imported: 0, updated: 0, ids: [], failedHandles: [], total: allHandles.length });

  const fetched = await Promise.allSettled(selected.map((productHandle) => fetchMiStoreProduct(productHandle, 'SE')));
  const products = fetched.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  const failedHandles = selected.filter((_, index) => fetched[index].status === 'rejected');
  if (!products.length) return Response.json({ processed: selected.length, imported: 0, updated: 0, ids: [], failedHandles, total: allHandles.length });

  const existing = await getD1().prepare(`SELECT p.id,p.sku,p.ean,c.mistore_handle FROM products p
    LEFT JOIN product_country_prices c ON c.product_id=p.id AND c.country='SE' ORDER BY p.created_at,p.rowid`).all();
  const byHandle = new Map<string, string>(); const bySku = new Map<string, string>(); const byEan = new Map<string, string>();
  for (const row of existing.results) {
    if (row.mistore_handle) byHandle.set(String(row.mistore_handle), String(row.id));
    if (row.sku) bySku.set(String(row.sku).toLowerCase(), String(row.id));
    if (row.ean) byEan.set(String(row.ean).toLowerCase(), String(row.id));
  }

  const db = getD1(); const statements: ReturnType<typeof db.prepare>[] = [];
  const ids = new Set<string>(); let imported = 0; let updated = 0;
  for (const product of products) {
    const productId = byHandle.get(product.handle) || (product.sku && bySku.get(product.sku.toLowerCase())) || (product.ean && byEan.get(product.ean.toLowerCase()));
    const id = productId || crypto.randomUUID();
    if (productId) {
      updated += 1;
      statements.push(db.prepare(`UPDATE products SET sku=CASE WHEN ?<>'' THEN ? ELSE sku END,
        ean=CASE WHEN ?<>'' THEN ? ELSE ean END,product_name=? WHERE id=?`)
        .bind(product.sku, product.sku, product.ean, product.ean, product.name, id));
    } else {
      imported += 1;
      statements.push(db.prepare(`INSERT INTO products
        (id,sku,product_name,ean,own_price_ore,currency,match_status,created_at)
        VALUES (?,?,?,?,0,'SEK','pending',?)`)
        .bind(id, product.sku, product.name, product.ean, new Date().toISOString()));
    }
    byHandle.set(product.handle, id);
    if (product.sku) bySku.set(product.sku.toLowerCase(), id);
    if (product.ean) byEan.set(product.ean.toLowerCase(), id);
    ids.add(id);
    statements.push(db.prepare(`INSERT INTO product_country_prices
      (product_id,country,currency,mistore_handle,mistore_name,mistore_url,mistore_price_minor)
      VALUES (?,'SE','SEK',?,?,?,?) ON CONFLICT(product_id,country) DO UPDATE SET
      mistore_handle=excluded.mistore_handle,mistore_name=excluded.mistore_name,
      mistore_url=excluded.mistore_url,mistore_price_minor=excluded.mistore_price_minor`)
      .bind(id, product.handle, product.name, product.url, product.priceMinor));
    statements.push(db.prepare(`INSERT INTO product_variants(product_id,country,variants_json) VALUES (?,'SE',?)
      ON CONFLICT(product_id,country) DO UPDATE SET variants_json=excluded.variants_json`)
      .bind(id, JSON.stringify(product.variants)));
  }
  await db.batch(statements);
  return Response.json({ processed: selected.length, imported, updated, ids: [...ids], failedHandles, total: allHandles.length });
}
