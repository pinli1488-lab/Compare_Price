import { getD1, type ProductRecord } from '@/db/store';
import { COUNTRY_CODES, COUNTRIES } from '@/lib/countries';
import { larkRequest, larkText, type LarkField } from '@/lib/lark';

const WIKI_TOKEN = 'VKlIwU3qZi124mkgYNYjJPakpYc';
const TABLE_ID = 'tblAjEg1bQPplNqx';
type Target = { baseToken: string; tableId: string };
type Row = { sku: string; name: string; ean: string; product: ProductRecord };
type RecordRow = { record_id?: string; fields: Record<string, string | number | null> };

export const MARKET_FIELDS: Array<{ name: string; type: 1 | 2 }> = [
  { name: 'SKU', type: 1 }, { name: 'PD Product Name', type: 1 }, { name: 'PD EAN', type: 1 },
  { name: 'PD Market Offers JSON', type: 1 },
  ...COUNTRY_CODES.flatMap(country => [
    { name: `PD ${country} Offers Updated`, type: 1 as const },
    ...Array.from({ length: 5 }, (_, index) => [
      { name: `PD ${country} #${index + 1} Price`, type: 2 as const },
      ...['Merchant', 'Currency', 'URL'].map(name => ({ name: `PD ${country} #${index + 1} ${name}`, type: 1 as const })),
    ]).flat(),
  ]),
];

export async function resolveMarketTarget(): Promise<Target> {
  const existing = await getD1().prepare('SELECT base_token,table_id FROM market_lark_target WHERE id=1').first();
  if (existing) return { baseToken: String(existing.base_token), tableId: String(existing.table_id) };
  const result = await larkRequest<{ node: { obj_type: string; obj_token: string } }>(`/open-apis/wiki/v2/spaces/get_node?token=${WIKI_TOKEN}`);
  if (result.node.obj_type !== 'bitable') throw new Error('The selected Wiki page is not a Lark Base.');
  const target = { baseToken: result.node.obj_token, tableId: TABLE_ID };
  await larkRequest(`/open-apis/bitable/v1/apps/${target.baseToken}/tables/${target.tableId}/fields?page_size=100`);
  await getD1().prepare('INSERT INTO market_lark_target(id,base_token,table_id) VALUES(1,?,?)').bind(target.baseToken, target.tableId).run();
  return target;
}

async function listAll<T>(path: string) {
  const items: T[] = []; let pageToken = '';
  do {
    const query = new URLSearchParams({ page_size: '100' });
    if (pageToken) query.set('page_token', pageToken);
    const result = await larkRequest<{ items?: T[]; has_more?: boolean; page_token?: string }>(`${path}?${query}`);
    items.push(...(result.items ?? [])); pageToken = result.has_more ? result.page_token ?? '' : '';
  } while (pageToken);
  return items;
}

export function marketFieldsForRow(row: Row) {
  const fields: Record<string, string | number | null> = { SKU: row.sku, 'PD Product Name': row.name, 'PD EAN': row.ean || null };
  const all: Record<string, unknown> = {};
  for (const country of COUNTRY_CODES) {
    const market = row.product.markets[country];
    // Legacy rows have only two offers. Never fabricate the missing ranks.
    const offers = market.marketOffers?.length ? market.marketOffers : [
      { merchant: market.lowMerchant, price: market.lowPriceMinor == null ? null : market.lowPriceMinor / 100 },
      { merchant: market.secondLowMerchant, price: market.secondLowPriceMinor == null ? null : market.secondLowPriceMinor / 100 },
    ].filter(offer => offer.price != null && offer.merchant).map(offer => ({ ...offer, currency: market.currency, url: market.marketProductUrl, condition: 'New', stockStatus: '' }));
    fields[`PD ${country} Offers Updated`] = market.offersUpdatedAt ?? market.updatedAt;
    for (let index = 0; index < 5; index++) {
      const offer = offers[index]; const prefix = `PD ${country} #${index + 1}`;
      fields[`${prefix} Price`] = offer?.price ?? null;
      fields[`${prefix} Merchant`] = offer?.merchant ?? null;
      fields[`${prefix} Currency`] = offer?.currency ?? null;
      fields[`${prefix} URL`] = offer?.url ?? null;
    }
    all[country] = { currency: COUNTRIES[country].currency, comparison_url: market.marketProductUrl, updated_at: fields[`PD ${country} Offers Updated`], offers };
  }
  fields['PD Market Offers JSON'] = JSON.stringify({ sku: row.sku, countries: all });
  return fields;
}

export async function publishMarketRows(rows: Row[]) {
  const target = await resolveMarketTarget();
  const path = `/open-apis/bitable/v1/apps/${target.baseToken}/tables/${target.tableId}`;
  const existing = await listAll<LarkField>(`${path}/fields`);
  const types = new Map(existing.map(field => [field.field_name, field.type]));
  for (const field of MARKET_FIELDS) if (types.has(field.name) && types.get(field.name) !== field.type) throw new Error(`Market table field type conflict: ${field.name}`);
  const missing = MARKET_FIELDS.filter(field => !types.has(field.name));
  for (const field of missing.slice(0, 8)) await larkRequest(`${path}/fields`, { method: 'POST', body: JSON.stringify({ field_name: field.name, type: field.type }) });
  if (missing.length > 8) return { marketPublished: 0, fieldsRemaining: missing.length - 8 };
  const existingRows = await listAll<{ record_id: string; fields: Record<string, unknown> }>(`${path}/records`);
  const bySku = new Map<string, string[]>();
  for (const row of existingRows) {
    const sku = larkText(row.fields.SKU).toLowerCase();
    if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), row.record_id]);
  }
  const creates: RecordRow[] = []; const updates: RecordRow[] = []; const seen = new Set<string>();
  for (const row of rows) {
    const sku = row.sku.trim().toLowerCase(); if (!sku || seen.has(sku)) continue; seen.add(sku);
    const ids = bySku.get(sku) ?? []; const fields = marketFieldsForRow(row);
    // Duplicate target SKUs are ambiguous: preserve their rows and surface the issue.
    if (ids.length > 1) throw new Error(`Duplicate SKU ${row.sku} in market table. Resolve duplicate rows before syncing.`);
    if (ids.length) updates.push({ record_id: ids[0], fields }); else creates.push({ fields });
  }
  for (const [kind, records] of [['batch_create', creates], ['batch_update', updates]] as const) {
    for (let index = 0; index < records.length; index += 10) await larkRequest(`${path}/records/${kind}`, { method: 'POST', body: JSON.stringify({ records: records.slice(index, index + 10) }) });
  }
  return { marketPublished: creates.length + updates.length, fieldsRemaining: 0 };
}
