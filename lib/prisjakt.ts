import { COUNTRIES, type CountryCode } from '@/lib/countries';

export type Candidate = { id: string; name: string; url: string; previewPrice: number | null; currency: string; confidence: number };
export type MarketOffer = { merchant: string; price: number; currency: string; url: string; condition: string; stockStatus: string };

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36';

function normalize(value: string) {
  return value.toLowerCase().replace(/\+/g, ' plus ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/(\d)\s+(gb|tb)\b/g, '$1$2').replace(/[^a-z0-9]+/g, ' ').trim();
}
function tokens(value: string) { return new Set(normalize(value).split(/\s+/).filter(Boolean)); }
const SPEC_LABELS = new Set(['ram', 'rom', 'storage', 'memory', 'dual', 'sim', 'smartphone', 'mobile', 'phone', 'mobiltelefon']);
const VARIANT_MARKERS = new Set(['pro', 'plus', 'ultra', 'max', 'lite', 'mini']);
function meaningfulTokens(value: string) { return new Set([...tokens(value)].filter((token) => !SPEC_LABELS.has(token))); }
function cleanReferenceTitle(value: string) {
  return value.replace(/\b(?:Räckvidd|Rækkevidde|Rekkevidde|Toimintasäde|Range|Kantama)\s*:\s*\d+(?:[.,]\d+)?\s*km\b.*$/i, '')
    .replace(/\b(?:Multiple color options available|Fås i flere farver)\b/gi, '')
    .replace(/\s+-\s+Default Title\s*$/i, '').replace(/\s+/g, ' ').trim();
}

const ACCESSORY_WORDS = new Set(['case', 'cover', 'screen', 'protector', 'film', 'filter', 'kit', 'charger', 'cable', 'adapter', 'sleeve', 'skal', 'fodral', 'kotelo', 'beskyttelse', 'suojakalvo', 'brake', 'brakes', 'disc', 'disk', 'bromsskiva', 'bremse', 'bremseskive', 'jarrulevy', 'spare', 'replacement', 'reservdel', 'varaosa']);
export function isPlausibleProductMatch(reference: string, candidate: string) {
  const cleanReference = cleanReferenceTitle(reference).replace(/^\s*[a-z0-9]{3,}-/i, '');
  const source = tokens(cleanReference); const target = tokens(candidate);
  // "For Xiaomi Scooter ..." is usually an accessory, even when the model number matches.
  if (![...ACCESSORY_WORDS].some((word) => source.has(word)) &&
    /(?:^|\s)(?:for|för|til|varten|passar)\s+(?:xiaomi|redmi|mi)\b/i.test(candidate)) return false;
  for (const word of ACCESSORY_WORDS) if (target.has(word) && !source.has(word)) return false;
  for (const marker of VARIANT_MARKERS) if (source.has(marker) !== target.has(marker)) return false;
  if ((source.has('4g') && target.has('5g')) || (source.has('5g') && target.has('4g'))) return false;
  const keyNumbers = [...source].filter((token) => /\d/.test(token) && !['4g', '5g', 'eu', 'gl'].includes(token));
  if (keyNumbers.some((token) => !target.has(token))) return false;
  return similarity(cleanReference, candidate) >= 0.5;
}

export function productIdFromUrl(value: string, country: CountryCode): string | null {
  const trimmed = value.trim();
  if (/^\d{5,}$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname !== new URL(COUNTRIES[country].marketOrigin).hostname) return null;
    const id = parsed.searchParams.get('p') ?? parsed.pathname.match(/\/(\d{5,})(?:\/|$)/)?.[1];
    return id && /^\d+$/.test(id) ? id : null;
  } catch { return null; }
}

export function similarity(left: string, right: string) {
  const a = normalize(left); const b = normalize(right);
  if (!a || !b) return 0; if (a === b) return 1;
  const at = meaningfulTokens(a); const bt = meaningfulTokens(b);
  const intersection = [...at].filter((token) => bt.has(token)).length;
  const union = new Set([...at, ...bt]).size || 1;
  const containment = a.includes(b) || b.includes(a) ? Math.min(a.length, b.length) / Math.max(a.length, b.length) : 0;
  const modelTokens = [...at].filter((token) => /\d/.test(token));
  const modelHits = modelTokens.length ? modelTokens.filter((token) => bt.has(token)).length / modelTokens.length : 1;
  const leftVariants = [...at].filter((token) => VARIANT_MARKERS.has(token));
  const rightVariants = [...bt].filter((token) => VARIANT_MARKERS.has(token));
  const variantMismatch = leftVariants.some((token) => !bt.has(token)) || rightVariants.some((token) => !at.has(token));
  return Math.max(0, Math.min(1, intersection / union * .35 + intersection / (at.size || 1) * .3 + containment * .1 + modelHits * .25 - (variantMismatch ? .25 : 0)));
}

function searchQueries(value: string) {
  const clean = cleanReferenceTitle(value);
  const queries = [clean];
  const noLabels = clean.replace(/\b(?:RAM|ROM|STORAGE|MEMORY)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const noCapacity = noLabels.replace(/\b\d+(?:[.,]\d+)?\s*(?:GB|TB)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const noGeneric = noCapacity.replace(/\b(?:DUAL\s*SIM|SMARTPHONE|MOBILE\s*PHONE|MOBILTELEFON|ELECTRIC|5G|4G|EU|GL|ROM)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  for (const query of [noLabels, noCapacity, noGeneric]) if (query && !queries.some((item) => normalize(item) === normalize(query))) queries.push(query);
  return queries;
}

async function remoteFetch(url: string, baseUrl: string, init: RequestInit = {}) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, 'accept-language': 'en,sv;q=0.8', accept: 'text/html,application/json;q=0.9,*/*;q=0.8', referer: baseUrl, ...init.headers }, redirect: 'follow' });
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error('Prisjakt connection failed');
}

export async function searchProducts(query: string, country: CountryCode = 'SE', referenceName?: string, allowProductId = true): Promise<Candidate[]> {
  const cleanQuery = query.trim(); if (!cleanQuery) return [];
  const config = COUNTRIES[country];
  const directId = allowProductId && !(cleanQuery.length >= 12 && isValidGtin(cleanQuery))
    ? productIdFromUrl(cleanQuery, country) : null;
  if (directId) return [{ id: directId, name: `Prisjakt product ${directId}`, url: `${config.marketOrigin}/produkt.php?p=${directId}`, previewPrice: null, currency: config.currency, confidence: 100 }];
  const graphQuery = `query suggestions($query: String!) { searchSuggestions(query: $query) { ... on SuggestedProduct { __typename text id category price } } }`;
  const found = new Map<string, Record<string, unknown>>();
  for (const searchQuery of searchQueries(cleanQuery)) {
    const response = await remoteFetch(`${config.marketOrigin}/_internal/bff`, config.marketOrigin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: graphQuery, variables: { query: searchQuery } }) });
    if (!response.ok) throw new Error(`Prisjakt search returned ${response.status}`);
    const payload = await response.json() as { data?: { searchSuggestions?: Array<Record<string, unknown>> } };
    for (const item of payload.data?.searchSuggestions ?? []) if (item.__typename === 'SuggestedProduct' && item.id && item.text) found.set(String(item.id), item);
    if (found.size >= 12) break;
    if (referenceName) {
      const plausible = [...found.values()].filter((item) => isPlausibleProductMatch(referenceName, String(item.text)));
      if (plausible.length === 1) break;
    }
  }
  return [...found.values()].map((item) => ({
    id: String(item.id), name: String(item.text), url: `${config.marketOrigin}/produkt.php?p=${item.id}`,
    previewPrice: item.price == null ? null : Number(item.price), currency: config.currency,
    confidence: Math.round(similarity(cleanQuery, String(item.text)) * 100),
  })).sort((a, b) => b.confidence - a.confidence).slice(0, 12);
}

function selectAutomaticMatch(reference: string, candidates: Candidate[]): Candidate | null {
  const plausible = candidates.filter((candidate) => isPlausibleProductMatch(reference, candidate.name))
    .map((candidate) => ({ ...candidate, confidence: Math.round(similarity(cleanReferenceTitle(reference), candidate.name) * 100) }))
    .sort((a, b) => b.confidence - a.confidence);
  const best = plausible[0];
  // A search hit is not proof of an exact EAN: the public suggestions contain no GTIN.
  if (!best || best.confidence < 50 || (plausible[1] && best.confidence - plausible[1].confidence < 8)) return null;
  return best;
}

function isValidGtin(value: string) {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === check;
}

export async function findMarketMatch(input: { name: string; ean?: string; sku?: string }, country: CountryCode): Promise<Candidate | null> {
  const ean = String(input.ean ?? '').trim();
  const sku = String(input.sku ?? '').trim();
  const queries = [
    isValidGtin(ean) ? ean : '',
    input.name.trim(),
    sku !== ean ? sku : '',
  ].filter(Boolean);
  let lastError: unknown; let succeeded = false;
  for (const query of queries) {
    try {
      const candidates = await searchProducts(query, country, input.name, false);
      succeeded = true;
      const match = selectAutomaticMatch(input.name, candidates);
      if (match) return match;
    } catch (error) { lastError = error; }
  }
  if (!succeeded && lastError) throw lastError;
  return null;
}

function unescapeJsonString(value: string) { try { return JSON.parse(`"${value}"`) as string; } catch { return value.replace(/\\u0026/g, '&').replace(/\\\//g, '/'); } }
function shouldExcludeMerchant(name: string) {
  const value = normalize(name).replace(/\s+/g, '');
  return value.includes('refurbed') || value.includes('renewed') || value.includes('reconditioned') ||
    value.includes('rekonditionerad') || value.includes('renoverad') || value.includes('brugt') ||
    value.includes('kaytetty') || value.includes('mistore');
}
function isNewCondition(condition: string) {
  const value = normalize(condition);
  return !value || value === 'new' || value === 'ny' || value === 'nyt' || value === 'uusi';
}

export async function fetchOffers(productId: string, country: CountryCode = 'SE'): Promise<MarketOffer[]> {
  if (!/^\d+$/.test(productId)) throw new Error('Invalid Prisjakt product id');
  const config = COUNTRIES[country];
  const response = await remoteFetch(`${config.marketOrigin}/produkt.php?p=${productId}`, config.marketOrigin);
  if (!response.ok) throw new Error(`Prisjakt returned ${response.status}`);
  const html = await response.text(); const offers: MarketOffer[] = [];
  const pattern = /\{\\"index\\":\d+,[\s\S]{0,5200}?\\"shop\\":\{\\"name\\":\\"(.*?)\\"[\s\S]{0,1800}?\\"promotion\\":/g;
  for (const match of html.matchAll(pattern)) {
    const block = match[0];
    const price = block.match(/\\"price\\":\{\\"amount\\":([\d.]+),\\"currency\\":\\"([A-Z]{3})\\"\},\\"priceType\\"/);
    const link = block.match(/\\"clickoutUrl\\":\\"(.*?)\\"/);
    const conditionMatch = block.match(/\\"condition\\":\\"(.*?)\\"/);
    const stock = block.match(/\\"stockStatus\\":\\"(.*?)\\"/);
    const merchant = unescapeJsonString(match[1]); const condition = conditionMatch ? unescapeJsonString(conditionMatch[1]) : '';
    if (!price || shouldExcludeMerchant(merchant) || !isNewCondition(condition) || !stock || unescapeJsonString(stock[1]) !== 'InStock') continue;
    offers.push({ merchant, price: Number(price[1]), currency: price[2], url: link ? unescapeJsonString(link[1]) : `${config.marketOrigin}/produkt.php?p=${productId}`, condition, stockStatus: stock ? unescapeJsonString(stock[1]) : '' });
  }
  const unique = new Map<string, MarketOffer>(); for (const offer of offers) unique.set(`${offer.merchant}|${offer.price}|${offer.url}`, offer);
  return [...unique.values()].sort((a, b) => a.price - b.price);
}
