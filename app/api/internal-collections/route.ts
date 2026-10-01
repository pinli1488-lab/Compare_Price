import { ensureSchema, getD1 } from '@/db/store';
import { isCollectionOverride } from '@/lib/internal-collections';

export const runtime = 'edge';

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json().catch(() => ({})) as { ids?: unknown; category?: unknown };
  if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 8 ||
    body.ids.some((id) => typeof id !== 'string' || !id) || !isCollectionOverride(body.category)) {
    return Response.json({ error: 'Provide up to eight product IDs and a valid collection.' }, { status: 400 });
  }
  const ids = [...new Set(body.ids as string[])];
  const now = new Date().toISOString();
  await getD1().batch(ids.map((id) => body.category === null
    ? getD1().prepare('DELETE FROM product_collection_overrides WHERE product_id=?').bind(id)
    : getD1().prepare(`INSERT INTO product_collection_overrides(product_id,category,updated_at)
      SELECT id,?,? FROM products WHERE id=? ON CONFLICT(product_id)
      DO UPDATE SET category=excluded.category,updated_at=excluded.updated_at`).bind(body.category, now, id)));
  return Response.json({ saved: true });
}
