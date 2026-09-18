import { emptyCountryPrice, ensureSchema, getD1, getProduct, mapCountryPrice, saveVariants, upsertCountryPrice } from '@/db/store';
import { COUNTRIES, isCountryCode } from '@/lib/countries';
import { fetchMiStoreProduct } from '@/lib/mistore';
import { fetchOffers, productIdFromUrl } from '@/lib/prisjakt';

export const runtime = 'edge';

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as {
    id?: string; country?: string; source?: 'mistore' | 'market';
    handle?: string; productId?: string; productName?: string; productUrl?: string; confidence?: number; sku?: string; ean?: string;
  };
  if (!body.id || !isCountryCode(body.country) || !body.source) return Response.json({ error: 'Invalid match request' }, { status: 400 });
  const product = await getProduct(body.id);
  if (!product) return Response.json({ error: 'Product not found' }, { status: 404 });
  const raw = await getD1().prepare('SELECT * FROM product_country_prices WHERE product_id=? AND country=?').bind(body.id, body.country).first();
  const current = raw ? mapCountryPrice(raw as Record<string, unknown>) : emptyCountryPrice(body.country);

  if (body.source === 'mistore') {
    if (!body.handle) return Response.json({ error: 'Invalid MiStore product' }, { status: 400 });
    const selected = await fetchMiStoreProduct(body.handle, body.country, body.sku || product.sku, body.ean || product.ean);
    await saveVariants(body.id, body.country, selected.variants);
    await upsertCountryPrice(body.id, { ...current, currency: COUNTRIES[body.country].currency, mistoreHandle: selected.handle, mistoreName: selected.name, mistoreUrl: selected.url, mistorePriceMinor: selected.priceMinor, updatedAt: new Date().toISOString() });
    if (body.country === 'SE') await getD1().prepare('UPDATE products SET sku=?, ean=?, product_name=? WHERE id=?')
      .bind(selected.sku, selected.ean, selected.name, body.id).run();
    return Response.json({ matched: true });
  }

  const productId = productIdFromUrl(body.productId || body.productUrl || '', body.country);
  if (!productId) return Response.json({ error: 'Enter a valid Prisjakt product URL or ID' }, { status: 400 });
  const offers = await fetchOffers(productId, body.country);
  const low = offers[0];
  if (!low) return Response.json({ error: 'No eligible new offers found' }, { status: 422 });
  await upsertCountryPrice(body.id, {
    ...current, currency: COUNTRIES[body.country].currency, marketProductId: productId,
    marketProductName: body.productName || current.mistoreName || product.productName, marketProductUrl: `${COUNTRIES[body.country].marketOrigin}/produkt.php?p=${productId}`,
    matchConfidence: body.confidence ?? 100, matchStatus: 'confirmed', lowPriceMinor: Math.round(low.price * 100),
    lowMerchant: low.merchant, lowUrl: low.url, updatedAt: new Date().toISOString(),
  });
  return Response.json({ matched: true });
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const body = await request.json() as { id?: string; country?: string; source?: 'mistore' | 'market' };
  if (!body.id || !isCountryCode(body.country) || !body.source) return Response.json({ error: 'Invalid match request' }, { status: 400 });
  const raw = await getD1().prepare('SELECT * FROM product_country_prices WHERE product_id=? AND country=?').bind(body.id, body.country).first();
  if (!raw) return Response.json({ removed: true });
  const current = mapCountryPrice(raw as Record<string, unknown>);
  if (body.source === 'mistore') {
    await upsertCountryPrice(body.id, { ...current, mistoreHandle: null, mistoreName: null, mistoreUrl: null, mistorePriceMinor: null, lowPriceMinor: null, lowMerchant: null, lowUrl: null, matchStatus: 'pending' });
    await getD1().prepare('DELETE FROM product_variants WHERE product_id=? AND country=?').bind(body.id, body.country).run();
  } else await upsertCountryPrice(body.id, { ...current, marketProductId: null, marketProductName: null, marketProductUrl: null, matchConfidence: null, matchStatus: 'pending', lowPriceMinor: null, lowMerchant: null, lowUrl: null });
  return Response.json({ removed: true });
}
