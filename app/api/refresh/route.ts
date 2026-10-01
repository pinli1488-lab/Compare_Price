import { emptyCountryPrice, ensureSchema, getD1, getProduct, mapCountryPrice, recordRefresh, saveVariants, upsertCountryPrice } from '@/db/store';
import { COUNTRIES, COUNTRY_CODES, type CountryCode } from '@/lib/countries';
import { fetchMiStoreProduct, searchMiStore } from '@/lib/mistore';
import { fetchOffers, findMarketMatch, isPlausibleProductMatch } from '@/lib/prisjakt';
import { recentSuccessfulRefresh } from '@/lib/refresh-policy';
import { databaseErrorResponse } from '@/lib/database-error';

export const runtime = 'edge';

async function refreshCountry(product: NonNullable<Awaited<ReturnType<typeof getProduct>>>, country: CountryCode, source: 'manual' | 'auto') {
  const raw = await getD1().prepare(`SELECT p.*, l.manual_at, l.auto_at, s.last_success_at
    FROM product_country_prices p LEFT JOIN price_refresh_log l ON l.product_id=p.product_id AND l.country=p.country
    LEFT JOIN price_refresh_success s ON s.product_id=p.product_id AND s.country=p.country
    WHERE p.product_id=? AND p.country=?`).bind(product.id, country).first();
  const recent = recentSuccessfulRefresh(raw as Record<string, unknown> | null);
  if (recent) return { status: 'skipped' as const, ...recent };
  const current = raw ? mapCountryPrice(raw as Record<string, unknown>) : emptyCountryPrice(country);

  const namedProduct = /[a-z]{3}/i.test(product.productName) && product.productName.toLowerCase() !== product.sku.toLowerCase();
  const validCandidate = (name: string, sku: string, ean: string) => {
    const exactSku = Boolean(product.sku && product.sku.toLowerCase() === sku.toLowerCase());
    const exact = exactSku || Boolean(product.ean && product.ean === ean);
    const newProduct = !/(?:class\s*[a-d]|refurbished|renewed|begagnad|brugt|k[äa]ytetty|renoverad)/i.test(name);
    return newProduct && (exactSku || (namedProduct ? isPlausibleProductMatch(product.productName, name) : exact));
  };
  let mistore = current.mistoreHandle
    ? await fetchMiStoreProduct(current.mistoreHandle, country, product.sku, product.ean).catch(() => null)
    : null;
  if (mistore && !validCandidate(mistore.name, mistore.sku, mistore.ean)) mistore = null;
  if (!mistore) {
    const candidates = await searchMiStore({ sku: product.sku, ean: product.ean, name: namedProduct ? product.productName : '' }, country);
    const candidate = candidates.find((item) => validCandidate(item.name, item.sku, item.ean));
    mistore = candidate ? await fetchMiStoreProduct(candidate.handle, country, product.sku, product.ean) : null;
  }
  if (!mistore) {
    const marketStillValid = current.matchStatus === 'confirmed';
    await upsertCountryPrice(product.id, { ...current, mistoreHandle: null, mistoreName: null, mistoreUrl: null, mistorePriceMinor: null,
      marketProductId: marketStillValid ? current.marketProductId : null,
      marketProductName: marketStillValid ? current.marketProductName : null,
      marketProductUrl: marketStillValid ? current.marketProductUrl : null,
      lowPriceMinor: null, lowMerchant: null, lowUrl: null, secondLowPriceMinor: null, secondLowMerchant: null, matchStatus: 'pending' });
    await recordRefresh(product.id, country, source, new Date().toISOString());
    const identity = await getD1().prepare(`SELECT mistore_name FROM product_country_prices
      WHERE product_id=? AND mistore_name IS NOT NULL AND mistore_name<>''
      ORDER BY CASE WHEN country='SE' THEN 0 ELSE 1 END LIMIT 1`).bind(product.id).first();
    const referenceName = identity?.mistore_name ? String(identity.mistore_name) : namedProduct ? product.productName : '';
    if (!referenceName) throw new Error(`${country}: No reliable MiStore match. Select a product manually.`);
    const selected = marketStillValid && current.marketProductId ? {
      id: current.marketProductId, name: current.marketProductName || referenceName,
      url: current.marketProductUrl || `${COUNTRIES[country].marketOrigin}/produkt.php?p=${current.marketProductId}`,
      confidence: current.matchConfidence ?? 100,
    } : await findMarketMatch({ name: referenceName, ean: product.ean, sku: product.sku }, country);
    if (!selected) throw new Error(`${country}: No reliable Prisjakt match. Search by name, EAN, or product URL manually.`);
    const offers = await fetchOffers(selected.id, country);
    const low = offers[0];
    if (!low) throw new Error(`${country}: No eligible new offer is available.`);
    const secondLow = offers.find((offer) => offer.merchant.trim().toLowerCase() !== low.merchant.trim().toLowerCase());
    const refreshedAt = new Date().toISOString();
    await upsertCountryPrice(product.id, {
      ...current, mistoreHandle: null, mistoreName: null, mistoreUrl: null, mistorePriceMinor: null,
      marketProductId: selected.id, marketProductName: selected.name, marketProductUrl: selected.url,
      matchConfidence: selected.confidence, matchStatus: marketStillValid ? 'confirmed' : 'auto',
      lowPriceMinor: Math.round(low.price * 100), lowMerchant: low.merchant, lowUrl: low.url,
      secondLowPriceMinor: secondLow ? Math.round(secondLow.price * 100) : null,
      secondLowMerchant: secondLow?.merchant ?? null, updatedAt: refreshedAt,
    });
    await recordRefresh(product.id, country, source, refreshedAt);
    return { status: 'updated' as const };
  }
  await saveVariants(product.id, country, mistore.variants);
  const oldMarketValid = current.matchStatus === 'confirmed' || Boolean(current.marketProductName && isPlausibleProductMatch(mistore.name, current.marketProductName));
  const withMiStore = {
    ...current, currency: COUNTRIES[country].currency,
    mistoreHandle: mistore.handle, mistoreName: mistore.name, mistoreUrl: mistore.url, mistorePriceMinor: mistore.priceMinor,
    marketProductId: oldMarketValid ? current.marketProductId : null,
    marketProductName: oldMarketValid ? current.marketProductName : null,
    marketProductUrl: oldMarketValid ? current.marketProductUrl : null,
    matchStatus: oldMarketValid ? current.matchStatus : 'pending' as const,
    lowPriceMinor: oldMarketValid ? current.lowPriceMinor : null,
    lowMerchant: oldMarketValid ? current.lowMerchant : null,
    lowUrl: oldMarketValid ? current.lowUrl : null,
    secondLowPriceMinor: oldMarketValid ? current.secondLowPriceMinor : null,
    secondLowMerchant: oldMarketValid ? current.secondLowMerchant : null,
    updatedAt: new Date().toISOString(),
  };
  await upsertCountryPrice(product.id, withMiStore);
  await getD1().prepare(`UPDATE products SET sku=CASE WHEN sku='' THEN ? ELSE sku END,
    ean=CASE WHEN ean='' THEN ? ELSE ean END,
    product_name=CASE WHEN product_name='' OR product_name=sku OR product_name=ean THEN ? ELSE product_name END WHERE id=?`)
    .bind(mistore.sku, mistore.ean, mistore.name, product.id).run();

  const candidate = withMiStore.marketProductId ? null : await findMarketMatch({ name: mistore.name, ean: mistore.ean || product.ean, sku: mistore.sku || product.sku }, country);
  const selected = withMiStore.marketProductId ? {
    id: withMiStore.marketProductId, name: withMiStore.marketProductName ?? mistore.name,
    url: withMiStore.marketProductUrl ?? `${COUNTRIES[country].marketOrigin}/produkt.php?p=${withMiStore.marketProductId}`,
    confidence: withMiStore.matchConfidence ?? 100,
  } : candidate;
  if (!selected) { await recordRefresh(product.id, country, source, new Date().toISOString()); throw new Error(`${country}: No reliable Prisjakt match. Search by name, EAN, or product URL manually.`); }
  const offers = await fetchOffers(selected.id, country);
  const low = offers[0];
  if (!low) { await recordRefresh(product.id, country, source, new Date().toISOString()); throw new Error(`${country}: No eligible new offer is available.`); }
  const refreshedAt = new Date().toISOString();
  const secondLow = offers.find((offer) => offer.merchant.trim().toLowerCase() !== low.merchant.trim().toLowerCase());
  await upsertCountryPrice(product.id, {
    ...withMiStore, marketProductId: selected.id, marketProductName: selected.name, marketProductUrl: selected.url,
    matchConfidence: selected.confidence, matchStatus: current.matchStatus === 'confirmed' && oldMarketValid ? 'confirmed' : 'auto',
    lowPriceMinor: Math.round(low.price * 100), lowMerchant: low.merchant, lowUrl: low.url, updatedAt: refreshedAt,
    secondLowPriceMinor: secondLow ? Math.round(secondLow.price * 100) : null,
    secondLowMerchant: secondLow?.merchant ?? null,
  });
  await recordRefresh(product.id, country, source, refreshedAt);
  await getD1().prepare(`INSERT INTO price_refresh_success(product_id,country,last_success_at) VALUES(?,?,?)
    ON CONFLICT(product_id,country) DO UPDATE SET last_success_at=excluded.last_success_at`).bind(product.id, country, refreshedAt).run();
  return { status: 'updated' as const };
}

export async function POST(request: Request) {
  try { return await refreshRequest(request); }
  catch (error) { return databaseErrorResponse(error); }
}

async function refreshRequest(request: Request) {
  await ensureSchema();
  const { ids, country, source } = await request.json() as { ids?: string[]; country?: CountryCode; source?: 'manual' | 'auto' };
  const safeIds = [...new Set(ids ?? [])].slice(0, 1);
  const countries = country && COUNTRY_CODES.includes(country) ? [country] : ['SE' as CountryCode];
  if (!safeIds.length) return Response.json({ updated: [], errors: [] });
  const updated: string[] = []; const errors: Array<{ id: string; country: string; message: string }> = [];
  const skipped: Array<{ id: string; country: string; refreshedAt: string; nextRefreshAt: string }> = [];
  for (const id of safeIds) {
    const product = await getProduct(id);
    if (!product) { errors.push({ id, country: '', message: 'Product not found' }); continue; }
    const results = await Promise.allSettled(countries.map((code) => refreshCountry(product, code, source === 'auto' ? 'auto' : 'manual')));
    results.forEach((result, index) => {
      if (result.status === 'rejected') errors.push({ id, country: countries[index], message: result.reason instanceof Error ? result.reason.message : 'Refresh failed' });
      else if (result.value.status === 'skipped') skipped.push({ id, country: countries[index], refreshedAt: result.value.refreshedAt, nextRefreshAt: result.value.nextRefreshAt });
    });
    if (results.some((result) => result.status === 'fulfilled' && result.value.status === 'updated')) updated.push(id);
  }
  return Response.json({ updated, errors, skipped });
}
