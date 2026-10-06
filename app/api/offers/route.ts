import { ensureSchema, getD1 } from '@/db/store';
import { isCountryCode } from '@/lib/countries';
import { fetchOffers, shouldExcludeMerchant, type MarketOffer } from '@/lib/prisjakt';
import { saveMarketOffers } from '@/lib/market-offers';
import { databaseErrorResponse } from '@/lib/database-error';

import { publishMarketPriceDesk } from '@/lib/lark-publish';

async function syncOffers(id: string) {
  try { return { lark: await publishMarketPriceDesk([id]) }; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getD1().prepare("INSERT INTO integration_status(integration,last_error) VALUES('lark_market',?) ON CONFLICT(integration) DO UPDATE SET last_error=excluded.last_error").bind(message).run();
    return { larkError: message };
  }
}

export const runtime = 'edge';
export async function POST(request: Request) {
  try {
    await ensureSchema();
    const { id, country } = await request.json() as { id?: string; country?: string };
    if (!id || !isCountryCode(country)) return Response.json({ error: 'Invalid product or country' }, { status: 400 });
    const price = await getD1().prepare('SELECT market_product_id FROM product_country_prices WHERE product_id=? AND country=?').bind(id, country).first();
    const productId = price?.market_product_id ? String(price.market_product_id) : null;
    if (!productId) return Response.json({ error: 'Match this product to Prisjakt first.' }, { status: 422 });
    const cached = await getD1().prepare('SELECT * FROM product_market_offers WHERE product_id=? AND country=? AND market_product_id=?').bind(id, country, productId).first();
    if (cached && Date.now() - Date.parse(String(cached.updated_at)) < 12 * 60 * 60 * 1000) {
      return Response.json({ offers: (JSON.parse(String(cached.offers_json)) as MarketOffer[]).filter(offer => !shouldExcludeMerchant(offer.merchant)), updatedAt: cached.updated_at, cached: true, ...(await syncOffers(id)) });
    }
    const offers = await fetchOffers(productId, country);
    if (!offers.length) return Response.json({ error: 'No eligible new in-stock offers found. Previous offers are retained.' }, { status: 422 });
    await saveMarketOffers(id, country, productId, offers);
    return Response.json({ offers, updatedAt: new Date().toISOString(), cached: false, ...(await syncOffers(id)) });
  } catch (error) { return databaseErrorResponse(error); }
}
