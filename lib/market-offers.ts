import { getD1 } from '@/db/store';
import type { CountryCode } from '@/lib/countries';
import type { MarketOffer } from '@/lib/prisjakt';
export async function saveMarketOffers(id: string, country: CountryCode, productId: string, offers: MarketOffer[], updatedAt = new Date().toISOString()) {
  await getD1().prepare(`INSERT INTO product_market_offers(product_id,country,market_product_id,offers_json,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(product_id,country) DO UPDATE SET market_product_id=excluded.market_product_id, offers_json=excluded.offers_json, updated_at=excluded.updated_at`)
    .bind(id, country, productId, JSON.stringify(offers), updatedAt).run();
  if (offers.length) {
    await getD1().prepare(`UPDATE product_country_prices SET low_price_minor=?,low_merchant=?,low_url=?,second_low_price_minor=?,second_low_merchant=? WHERE product_id=? AND country=? AND market_product_id=?`)
      .bind(Math.round(offers[0].price*100), offers[0].merchant, offers[0].url, offers[1] ? Math.round(offers[1].price*100) : null, offers[1]?.merchant ?? null, id, country, productId).run();
    await getD1().prepare('DELETE FROM lark_publish_log WHERE product_id=?').bind(id).run();
  }
}
