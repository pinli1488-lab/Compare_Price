import { ensureSchema, getD1, mapProduct } from '@/db/store';

export const runtime = 'edge';

export async function GET() {
  await ensureSchema();
  const result = await getD1().prepare('SELECT * FROM products ORDER BY created_at DESC').all();
  return Response.json({ products: result.results.map((row) => mapProduct(row as Record<string, unknown>)) });
}

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as { products?: Array<{ sku?: string; productName?: string; ean?: string; ownPrice?: number; currency?: string }> };
  const rows = (body.products ?? []).filter((item) => item.productName?.trim() && Number.isFinite(Number(item.ownPrice))).slice(0, 1200);
  if (!rows.length) return Response.json({ error: '没有可导入的有效产品' }, { status: 400 });
  const now = new Date().toISOString();
  const statements = rows.map((item) => getD1().prepare(`INSERT INTO products
    (id, sku, product_name, ean, own_price_ore, currency, match_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(crypto.randomUUID(), String(item.sku ?? ''), String(item.productName).trim(), String(item.ean ?? ''), Math.round(Number(item.ownPrice) * 100), item.currency ?? 'SEK', now));
  for (let index = 0; index < statements.length; index += 80) await getD1().batch(statements.slice(index, index + 80));
  return Response.json({ imported: rows.length });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const { ids } = await request.json() as { ids?: string[] };
  const safeIds = (ids ?? []).slice(0, 1200);
  if (!safeIds.length) return Response.json({ deleted: 0 });
  const statements = safeIds.map((id) => getD1().prepare('DELETE FROM products WHERE id = ?').bind(id));
  for (let index = 0; index < statements.length; index += 80) await getD1().batch(statements.slice(index, index + 80));
  return Response.json({ deleted: safeIds.length });
}
