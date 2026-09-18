import { COUNTRIES, type CountryCode } from '@/lib/countries';
import { similarity } from '@/lib/prisjakt';

export type MiStoreCandidate = {
  handle: string;
  name: string;
  url: string;
  priceMinor: number;
  currency: string;
  sku: string;
  ean: string;
  variantTitle: string;
  confidence: number;
  exactIdentifier: boolean;
};

type ShopifyVariant = { sku?: string; barcode?: string; price?: number; available?: boolean; title?: string };
type ShopifyProduct = { title?: string; handle?: string; variants?: ShopifyVariant[] };

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36';

function cleanProductPath(url: string) {
  return url.split('?')[0].replace(/\.js$/, '');
}

function normalize(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json', 'accept-language': 'en,sv;q=0.8' } });
  if (!response.ok) throw new Error(`MiStore returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function searchOnce(query: string, country: CountryCode) {
  const config = COUNTRIES[country];
  const params = new URLSearchParams({ q: query, 'resources[type]': 'product', 'resources[limit]': '8' });
  const payload = await getJson<{ resources?: { results?: { products?: Array<{ title?: string; url?: string }> } } }>(`${config.mistoreOrigin}/search/suggest.json?${params}`);
  return payload.resources?.results?.products ?? [];
}

export async function searchMiStore(
  input: { sku?: string; ean?: string; name?: string } | string,
  country: CountryCode,
): Promise<MiStoreCandidate[]> {
  const parts = typeof input === 'string' ? { name: input } : input;
  if (typeof input === 'string') {
    try {
      const direct = new URL(input.trim()); const origin = new URL(COUNTRIES[country].mistoreOrigin);
      const handle = direct.hostname === origin.hostname ? direct.pathname.match(/^\/products\/([^/]+)/)?.[1] : null;
      if (handle) {
        const product = await fetchMiStoreProduct(handle, country);
        const selected = product.variants[0];
        return [{ ...product, sku: selected?.sku ?? product.sku, ean: selected?.ean ?? product.ean,
          variantTitle: selected?.title ?? '', confidence: 100, exactIdentifier: true }];
      }
    } catch { /* Treat as a search phrase. */ }
  }
  const queries = [parts.ean, parts.sku, parts.name].map((value) => String(value ?? '').trim()).filter(Boolean);
  const found = new Map<string, { title?: string; url?: string }>();
  for (const query of queries) {
    for (const item of await searchOnce(query, country)) {
      const path = item.url ? cleanProductPath(item.url) : '';
      if (path) found.set(path, item);
    }
    if (found.size >= 6) break;
  }

  const config = COUNTRIES[country];
  const candidates: MiStoreCandidate[] = [];
  for (const [path, item] of [...found.entries()].slice(0, 8)) {
    try {
      const product = await getJson<ShopifyProduct>(`${config.mistoreOrigin}${path}.js`);
      const variants = product.variants ?? [];
      const exact = variants.find((variant) =>
        (parts.ean && normalize(String(variant.barcode ?? '')) === normalize(parts.ean)) ||
        (parts.sku && normalize(String(variant.sku ?? '')) === normalize(parts.sku)),
      );
      const selected = exact ?? variants.find((variant) => variant.available !== false) ?? variants[0];
      if (!selected || !Number.isFinite(Number(selected.price))) continue;
      const name = String(product.title ?? item.title ?? '').trim();
      const exactIdentifier = Boolean(exact);
      candidates.push({
        handle: String(product.handle ?? path.split('/').filter(Boolean).at(-1) ?? ''),
        name,
        url: `${config.mistoreOrigin}${path}`,
        priceMinor: Number(selected.price),
        currency: config.currency,
        sku: String(selected.sku ?? ''),
        ean: String(selected.barcode ?? ''),
        variantTitle: String(selected.title ?? ''),
        confidence: exactIdentifier ? 100 : Math.round(similarity(parts.name ?? queries[0] ?? '', name) * 100),
        exactIdentifier,
      });
    } catch { /* Ignore one broken candidate and keep the rest. */ }
  }
  return candidates.sort((a, b) => b.confidence - a.confidence);
}

export async function fetchMiStoreProduct(handle: string, country: CountryCode, sku?: string, ean?: string) {
  const config = COUNTRIES[country];
  const product = await getJson<ShopifyProduct>(`${config.mistoreOrigin}/products/${encodeURIComponent(handle)}.js`);
  const variants = product.variants ?? [];
  const selected = variants.find((variant) =>
    (ean && normalize(String(variant.barcode ?? '')) === normalize(ean)) ||
    (sku && normalize(String(variant.sku ?? '')) === normalize(sku)),
  ) ?? variants.find((variant) => variant.available !== false) ?? variants[0];
  if (!selected || !Number.isFinite(Number(selected.price))) throw new Error('MiStore product has no available price');
  return {
    handle,
    name: String(product.title ?? ''),
    url: `${config.mistoreOrigin}/products/${encodeURIComponent(handle)}`,
    priceMinor: Number(selected.price),
    currency: config.currency,
    sku: String(selected.sku ?? ''),
    ean: String(selected.barcode ?? ''),
    variants: variants.filter((variant) => Number.isFinite(Number(variant.price))).map((variant) => ({
      sku: String(variant.sku ?? ''), ean: String(variant.barcode ?? ''), title: String(variant.title ?? ''), priceMinor: Number(variant.price),
    })),
  };
}
