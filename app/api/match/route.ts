import { ensureSchema, getD1 } from '@/db/store';
import { fetchOffers } from '@/lib/prisjakt';

export const runtime = 'edge';

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as { id?: string; productId?: string; productName?: string; productUrl?: string };
  if (!body.id || !body.productId || !/^\d+$/.test(body.productId)) return Response.json({ error: '匹配数据无效' }, { status: 400 });
  const offers = await fetchOffers(body.productId);
  const low = offers[0];
  const high = offers.at(-1);
  if (!low || !high) return Response.json({ error: '排除 Mistore 后没有可用报价' }, { status: 422 });
  await getD1().prepare(`UPDATE products SET matched_product_id=?, matched_product_name=?, matched_product_url=?, match_confidence=100,
    match_status='confirmed', low_price_ore=?, low_merchant=?, low_url=?, high_price_ore=?, high_merchant=?, high_url=?, updated_at=? WHERE id=?`)
    .bind(body.productId, body.productName ?? '', body.productUrl ?? `https://www.prisjakt.nu/produkt.php?p=${body.productId}`, Math.round(low.price * 100), low.merchant, low.url, Math.round(high.price * 100), high.merchant, high.url, new Date().toISOString(), body.id).run();
  return Response.json({ matched: true });
}
