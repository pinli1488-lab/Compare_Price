import { COUNTRY_CODES, type CountryCode } from '@/lib/countries';
import { batchWritePriceDeskRecords, createPriceDeskField, isLarkConfigured, LARK_FIELDS, larkText, listPriceDeskFields, listPriceDeskRecords } from '@/lib/lark';
import { getD1, mapProducts, type LarkCostRecord, type ProductRecord, type ProductVariant } from '@/db/store';
import { productDisplayName } from '@/lib/product-name';

type FieldValue = string | number | null;
type Group = { primary: ProductRecord; members: ProductRecord[] };
type Variant = ProductVariant & { fallbackName: string };

const rate: Record<CountryCode, number> = { SE: 1, DK: 1.48, FI: 11.07, NO: 1 };
const vat: Record<CountryCode, number> = { SE: 1.25, DK: 1.25, FI: 1.255, NO: 1.25 };
const textFields = ['PD Row No', 'PD Product Name', 'PD EAN', 'PD Variant'];
const countryFields = [
  ['MiStore Price', 2], ['MiStore Diff %', 2], ['MiStore URL', 1],
  ['Lowest Price', 2], ['Lowest Merchant', 1], ['Second Lowest Price', 2],
  ['Second Merchant', 1], ['Prisjakt URL', 1], ['Expected Price', 2],
  ['Expected Diff %', 2], ['Profit SEK', 2], ['Margin %', 2], ['Cost Price', 2],
  ['Manual Refresh', 1], ['Automatic Refresh', 1],
] as const;

export const PRICE_DESK_FIELDS: Array<{ name: string; type: 1 | 2 }> = [
  ...textFields.map((name) => ({ name, type: 1 as const })),
  ...COUNTRY_CODES.flatMap((country) => countryFields.map(([name, type]) => ({ name: `PD ${country} ${name}`, type }))),
];

const key = (sku: string) => sku.trim().toLowerCase();
const amount = (minor: number | null) => minor == null ? null : minor / 100;
const percent = (value: number | null, market: number | null) =>
  value == null || market == null || market <= 0 ? null : Math.round(((value - market) / market) * 1000) / 10;

function profit(record: LarkCostRecord | undefined, country: CountryCode, expectedPriceMinor: number | null) {
  if (!record || record.status !== 'ok' || record.costSekMinor == null || expectedPriceMinor == null || expectedPriceMinor <= 0) return null;
  const logistics = country === 'SE' ? record.seLogisticsSekMinor : country === 'DK' ? record.dkLogisticsSekMinor : country === 'FI' ? record.fiLogisticsSekMinor : record.noLogisticsSekMinor;
  if (record.warehouseSekMinor == null || logistics == null || record.fixedFeeSekMinor == null) return null;
  const grossSek = expectedPriceMinor * rate[country];
  let value = grossSek / vat[country] - record.costSekMinor - record.warehouseSekMinor - logistics - record.fixedFeeSekMinor +
    (record.rabattSekMinor ?? 0) - grossSek * 0.03;
  if (country === 'SE') value -= (record.chemicalTaxSeSekMinor ?? 0) + (record.copySweSekMinor ?? 0);
  if (country === 'DK') value -= record.copyDkSekMinor ?? 0;
  const profitMinor = country === 'DK' || country === 'FI' ? Math.round(value / 100) * 100 : Math.round(value / 10) * 10;
  return { profitSek: profitMinor / 100, margin: Math.round(value / grossSek * 100) };
}

function groupProducts(products: ProductRecord[]) {
  const groups = new Map<string, Group>();
  for (const product of products) {
    const match = COUNTRY_CODES.map((country) => product.markets[country].mistoreHandle ? `${country}:${product.markets[country].mistoreHandle}` : '').find(Boolean);
    const groupKey = match ? `mistore:${match}` : `product:${product.id}`;
    const group = groups.get(groupKey);
    if (group) group.members.push(product);
    else groups.set(groupKey, { primary: product, members: [product] });
  }
  return [...groups.values()];
}

function groupVariants(group: Group) {
  const variants = new Map<string, Variant>();
  for (const member of group.members) {
    if (member.sku) variants.set(key(member.sku), { sku: member.sku, ean: member.ean, title: '', priceMinor: member.markets.SE.mistorePriceMinor ?? 0, fallbackName: member.productName });
    for (const country of COUNTRY_CODES) for (const variant of member.variants[country]) {
      if (!variant.sku) continue;
      const existing = variants.get(key(variant.sku));
      variants.set(key(variant.sku), { ...variant, fallbackName: member.productName,
        ean: variant.ean || existing?.ean || '', title: variant.title || existing?.title || '' });
    }
  }
  return [...variants.values()];
}

async function loadProducts() {
  const db = getD1();
  const [products, prices, variants, costs] = await Promise.all([
    db.prepare('SELECT id,sku,product_name,ean,created_at FROM products ORDER BY created_at ASC, rowid ASC').all(),
    db.prepare(`SELECT p.*, l.manual_at, l.auto_at FROM product_country_prices p
      LEFT JOIN price_refresh_log l ON l.product_id=p.product_id AND l.country=p.country`).all(),
    db.prepare('SELECT * FROM product_variants').all(),
    db.prepare('SELECT * FROM lark_product_costs').all(),
  ]);
  return mapProducts(products.results as Record<string, unknown>[], prices.results as Record<string, unknown>[],
    variants.results as Record<string, unknown>[], costs.results as Record<string, unknown>[]);
}

function fieldsForVariant(group: Group, variant: Variant, groupIndex: number, variantIndex: number, variantCount: number): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {
    'PD Row No': `${groupIndex + 1}${variantCount > 1 ? `.${variantIndex + 1}` : ''}`,
    'PD Product Name': variant.title && !/^default title$/i.test(variant.title.trim()) && productDisplayName(group.primary) !== 'Name pending'
      ? `${productDisplayName(group.primary)} - ${variant.title}`
      : productDisplayName(group.primary),
    'PD EAN': variant.ean || null,
    'PD Variant': variant.title && !/^default title$/i.test(variant.title.trim()) ? variant.title : null,
  };
  const larkCost = group.members.map((member) => member.larkCosts[key(variant.sku)]).find(Boolean);
  for (const country of COUNTRY_CODES) {
    const market = group.primary.markets[country];
    const countryVariant = group.members.flatMap((member) => member.variants[country])
      .find((item) => key(item.sku) === key(variant.sku) || (variant.ean && item.ean === variant.ean));
    const memberPrice = group.members.find((member) => key(member.sku) === key(variant.sku))?.markets[country].mistorePriceMinor;
    const mistorePrice = countryVariant?.priceMinor ?? memberPrice ?? market.mistorePriceMinor;
    const expected = market.expectedPriceMinor;
    const result = profit(larkCost, country, expected);
    const prefix = `PD ${country} `;
    fields[`${prefix}MiStore Price`] = amount(mistorePrice);
    fields[`${prefix}MiStore Diff %`] = percent(mistorePrice, market.lowPriceMinor);
    fields[`${prefix}MiStore URL`] = market.mistoreUrl;
    fields[`${prefix}Lowest Price`] = amount(market.lowPriceMinor);
    fields[`${prefix}Lowest Merchant`] = market.lowMerchant;
    fields[`${prefix}Second Lowest Price`] = amount(market.secondLowPriceMinor);
    fields[`${prefix}Second Merchant`] = market.secondLowMerchant;
    fields[`${prefix}Prisjakt URL`] = market.marketProductUrl;
    fields[`${prefix}Expected Price`] = amount(expected);
    fields[`${prefix}Expected Diff %`] = percent(expected, market.lowPriceMinor);
    fields[`${prefix}Profit SEK`] = result?.profitSek ?? null;
    fields[`${prefix}Margin %`] = result?.margin ?? null;
    fields[`${prefix}Cost Price`] = larkCost?.status === 'ok' && larkCost.costSekMinor != null ? amount(Math.round(larkCost.costSekMinor / rate[country])) : null;
    fields[`${prefix}Manual Refresh`] = market.manualRefreshedAt;
    fields[`${prefix}Automatic Refresh`] = market.autoRefreshedAt;
  }
  return fields;
}

export async function publishPriceDesk(ids: string[]) {
  if (!isLarkConfigured()) throw new Error('Lark is not connected');
  const existingFields = await listPriceDeskFields();
  const names = new Map(existingFields.map((field) => [field.field_name, field.type]));
  const missingFields = PRICE_DESK_FIELDS.filter((field) => !names.has(field.name));
  for (const field of missingFields.slice(0, 8)) await createPriceDeskField(field.name, field.type);
  if (missingFields.length > 8) return { fieldsCreated: 8, fieldsRemaining: missingFields.length - 8, published: 0, createdRows: 0, duplicateSkus: [] as string[] };
  for (const field of PRICE_DESK_FIELDS) {
    const existingType = names.get(field.name);
    if (existingType != null && existingType !== field.type) throw new Error(`Lark field ${field.name} has an incompatible type`);
  }
  const [products, larkRows] = await Promise.all([loadProducts(), listPriceDeskRecords([LARK_FIELDS.sku])]);
  const selected = new Set(ids);
  const groups = groupProducts(products);
  const rowsBySku = new Map<string, string[]>();
  for (const row of larkRows) {
    const sku = key(larkText(row.fields[LARK_FIELDS.sku]));
    if (sku) rowsBySku.set(sku, [...(rowsBySku.get(sku) ?? []), row.record_id]);
  }
  const updates: Array<{ record_id: string; fields: Record<string, FieldValue> }> = [];
  const creates: Array<{ fields: Record<string, FieldValue> }> = [];
  const duplicateSkus = new Set<string>();
  const publishedProductIds = new Set<string>();
  const seenSku = new Set<string>();
  for (const [groupIndex, group] of groups.entries()) {
    if (!group.members.some((member) => selected.has(member.id))) continue;
    const variants = groupVariants(group);
    for (const [variantIndex, variant] of variants.entries()) {
      const normalized = key(variant.sku);
      if (!normalized) continue;
      if (seenSku.has(normalized)) { duplicateSkus.add(variant.sku); continue; }
      seenSku.add(normalized);
      const fields = fieldsForVariant(group, variant, groupIndex, variantIndex, variants.length);
      const recordIds = rowsBySku.get(normalized) ?? [];
      if (recordIds.length > 1) duplicateSkus.add(variant.sku);
      if (recordIds.length) updates.push(...recordIds.map((recordId) => ({ record_id: recordId, fields })));
      else creates.push({ fields: { [LARK_FIELDS.sku]: variant.sku, ...fields } });
    }
    if (variants.some((variant) => variant.sku.trim())) {
      for (const member of group.members) publishedProductIds.add(member.id);
    }
  }
  for (let offset = 0; offset < updates.length; offset += 10) await batchWritePriceDeskRecords('update', updates.slice(offset, offset + 10));
  for (let offset = 0; offset < creates.length; offset += 10) await batchWritePriceDeskRecords('create', creates.slice(offset, offset + 10));
  const now = new Date().toISOString();
  if (publishedProductIds.size) await getD1().batch([...publishedProductIds].map((id) => getD1().prepare(`INSERT INTO lark_publish_log(product_id,published_at) VALUES(?,?)
    ON CONFLICT(product_id) DO UPDATE SET published_at=excluded.published_at`).bind(id, now)));
  return { fieldsCreated: missingFields.length, fieldsRemaining: 0, published: updates.length + creates.length,
    createdRows: creates.length, duplicateSkus: [...duplicateSkus] };
}
