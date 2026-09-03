export type Candidate = {
  id: string;
  name: string;
  url: string;
  previewPrice: number | null;
  currency: string;
  confidence: number;
};

export type MarketOffer = {
  merchant: string;
  price: number;
  currency: string;
  url: string;
  condition: string;
  stockStatus: string;
};

const BASE_URL = 'https://www.prisjakt.nu';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

function normalize(value: string) {
  return value.toLowerCase().replace(/\+/g, ' plus ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function tokens(value: string) {
  return new Set(normalize(value).split(/\s+/).filter(Boolean));
}

const SPEC_LABELS = new Set(['ram', 'rom', 'storage', 'memory', 'dual', 'sim', 'smartphone', 'mobile', 'phone', 'mobiltelefon']);
const VARIANT_MARKERS = new Set(['pro', 'plus', 'ultra', 'max', 'lite', 'mini']);

function meaningfulTokens(value: string) {
  return new Set([...tokens(value)].filter((token) => !SPEC_LABELS.has(token)));
}

export function similarity(left: string, right: string) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const at = meaningfulTokens(a);
  const bt = meaningfulTokens(b);
  const intersection = [...at].filter((token) => bt.has(token)).length;
  const union = new Set([...at, ...bt]).size || 1;
  const tokenScore = intersection / union;
  const queryCoverage = intersection / (at.size || 1);
  const containment = a.includes(b) || b.includes(a) ? Math.min(a.length, b.length) / Math.max(a.length, b.length) : 0;
  const modelTokens = [...at].filter((token) => /\d/.test(token));
  const modelHits = modelTokens.length ? modelTokens.filter((token) => bt.has(token)).length / modelTokens.length : 1;
  const leftVariants = [...at].filter((token) => VARIANT_MARKERS.has(token));
  const rightVariants = [...bt].filter((token) => VARIANT_MARKERS.has(token));
  const variantMismatch = leftVariants.some((token) => !bt.has(token)) || rightVariants.some((token) => !at.has(token));
  const score = tokenScore * 0.35 + queryCoverage * 0.3 + containment * 0.1 + modelHits * 0.25;
  return Math.max(0, Math.min(1, score - (variantMismatch ? 0.25 : 0)));
}

function searchQueries(value: string) {
  const queries = [value.trim()];
  const withoutLabels = value.replace(/\b(?:RAM|ROM|STORAGE|MEMORY)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const withoutCapacity = withoutLabels.replace(/\b\d+(?:[.,]\d+)?\s*(?:GB|TB)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const withoutGenericWords = withoutCapacity.replace(/\b(?:DUAL\s*SIM|SMARTPHONE|MOBILE\s*PHONE|MOBILTELEFON)\b/gi, ' ').replace(/\s+/g, ' ').trim();

  for (const query of [withoutLabels, withoutCapacity, withoutGenericWords]) {
    if (query && !queries.some((existing) => normalize(existing) === normalize(query))) queries.push(query);
  }
  return queries;
}

async function remoteFetch(url: string, init: RequestInit = {}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, 'accept-language': 'sv-SE,sv;q=0.9,en;q=0.7', accept: 'text/html,application/json;q=0.9,*/*;q=0.8', referer: BASE_URL, ...init.headers }, redirect: 'follow' });
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error('Prisjakt connection failed');
}

async function fetchHtml(url: string) {
  const response = await remoteFetch(url);
  if (!response.ok) throw new Error(`Prisjakt returned ${response.status}`);
  return response.text();
}

export async function searchProducts(query: string): Promise<Candidate[]> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return [];
  const graphQuery = `query suggestions($query: String!) {
    searchSuggestions(query: $query) {
      ... on SuggestedProduct { __typename text id category price }
    }
  }`;
  const found = new Map<string, Record<string, unknown>>();
  for (const searchQuery of searchQueries(cleanQuery)) {
    const response = await remoteFetch(`${BASE_URL}/_internal/bff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: graphQuery, variables: { query: searchQuery } }),
    });
    if (!response.ok) throw new Error(`Prisjakt search returned ${response.status}`);
    const payload = await response.json() as { data?: { searchSuggestions?: Array<Record<string, unknown>> } };
    for (const item of payload.data?.searchSuggestions ?? []) {
      if (item.__typename === 'SuggestedProduct' && item.id && item.text) found.set(String(item.id), item);
    }
    if (found.size >= 8) break;
  }

  return [...found.values()].map((item) => ({
    id: String(item.id),
    name: String(item.text),
    url: `${BASE_URL}/produkt.php?p=${item.id}`,
    previewPrice: item.price == null ? null : Number(item.price),
    currency: 'SEK',
    confidence: Math.round(similarity(cleanQuery, String(item.text)) * 100),
  }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 8);
}

function unescapeJsonString(value: string) {
  try { return JSON.parse(`"${value}"`) as string; } catch { return value.replace(/\\u0026/g, '&').replace(/\\\//g, '/'); }
}

function isOwnStore(name: string) {
  const value = normalize(name).replace(/\s+/g, '').replace(/\./g, '');
  return value === 'mistore' || value === 'mistorese';
}

export async function fetchOffers(productId: string): Promise<MarketOffer[]> {
  if (!/^\d+$/.test(productId)) throw new Error('Invalid Prisjakt product id');
  const html = await fetchHtml(`${BASE_URL}/produkt.php?p=${productId}`);
  const offers: MarketOffer[] = [];
  const pattern = /\{\\"index\\":\d+,[\s\S]{0,5200}?\\"shop\\":\{\\"name\\":\\"(.*?)\\"[\s\S]{0,1800}?\\"promotion\\":/g;
  for (const match of html.matchAll(pattern)) {
    const block = match[0];
    const price = block.match(/\\"price\\":\{\\"amount\\":([\d.]+),\\"currency\\":\\"([A-Z]{3})\\"\},\\"priceType\\"/);
    const link = block.match(/\\"clickoutUrl\\":\\"(.*?)\\"/);
    const condition = block.match(/\\"condition\\":\\"(.*?)\\"/);
    const stock = block.match(/\\"stockStatus\\":\\"(.*?)\\"/);
    const merchant = unescapeJsonString(match[1]);
    if (!price || isOwnStore(merchant)) continue;
    offers.push({
      merchant,
      price: Number(price[1]),
      currency: price[2],
      url: link ? unescapeJsonString(link[1]) : `${BASE_URL}/produkt.php?p=${productId}`,
      condition: condition ? unescapeJsonString(condition[1]) : '',
      stockStatus: stock ? unescapeJsonString(stock[1]) : '',
    });
  }
  const unique = new Map<string, MarketOffer>();
  for (const offer of offers) unique.set(`${offer.merchant}|${offer.price}|${offer.url}`, offer);
  return [...unique.values()].sort((a, b) => a.price - b.price);
}

export async function resolveMarketPrice(query: string, selectedProductId?: string) {
  const candidates = await searchProducts(query);
  const selected = selectedProductId ? candidates.find((candidate) => candidate.id === selectedProductId) ?? {
    id: selectedProductId, name: query, url: `${BASE_URL}/produkt.php?p=${selectedProductId}`, previewPrice: null, currency: 'SEK', confidence: 100,
  } : candidates[0];
  if (!selected) return { candidates, selected: null, offers: [], low: null, high: null };
  const offers = await fetchOffers(selected.id);
  return { candidates, selected, offers, low: offers[0] ?? null, high: offers.at(-1) ?? null };
}
