import { ensureSchema, getD1, mapProduct } from '@/db/store';
import { fetchOffers, searchProducts } from '@/lib/prisjakt';

export const runtime = 'edge';

export async function POST(request: Request) {
  await ensureSchema();
  const { ids } = await request.json() as { ids?: string[] };
  const safeIds = (ids ?? []).slice(0, 8);
  if (!safeIds.length) return Response.json({ updated: [], errors: [] });
  const placeholders = safeIds.map(() => '?').join(',');
  const result = await getD1().prepare(`SELECT * FROM products WHERE id IN (${placeholders})`).bind(...safeIds).all();
  const updated: string[] = [];
  const errors: Array<{ id: string; message: string }> = [];

  for (const raw of result.results) {
    const product = mapProduct(raw as Record<string, unknown>);
    try {
      let productId = product.matchedProductId;
      let matchedName = product.matchedProductName;
      let matchedUrl = product.matchedProductUrl;
      let confidence = product.matchConfidence;
      let matchStatus = product.matchStatus;
      if (!productId) {
        const candidates = await searchProducts(product.productName);
        const best = candidates[0];
        if (!best) {
          await getD1().prepare("UPDATE products SET match_status = 'not_found', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), product.id).run();
          errors.push({ id: product.id, message: '没有找到匹配商品' });
          continue;
        }
        productId = best.id; matchedName = best.name; matchedUrl = best.url; confidence = best.confidence;
        matchStatus = best.confidence >= 72 ? 'auto' : 'pending';
      }
      const offers = await fetchOffers(productId);
      const low = offers[0];
      const high = offers.at(-1);
      if (!low || !high) throw new Error('排除 Mistore 后没有可用报价');
      const now = new Date().toISOString();
      await getD1().prepare(`UPDATE products SET
        matched_product_id=?, matched_product_name=?, matched_product_url=?, match_confidence=?, match_status=?,
        low_price_ore=?, low_merchant=?, low_url=?, high_price_ore=?, high_merchant=?, high_url=?, updated_at=? WHERE id=?`)
        .bind(productId, matchedName, matchedUrl, confidence, matchStatus, Math.round(low.price * 100), low.merchant, low.url, Math.round(high.price * 100), high.merchant, high.url, now, product.id).run();
      updated.push(product.id);
    } catch (error) {
      errors.push({ id: product.id, message: error instanceof Error ? error.message : '更新失败' });
    }
  }
  return Response.json({ updated, errors });
}
