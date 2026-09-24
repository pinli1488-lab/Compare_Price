'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import readXlsxFile from 'read-excel-file';

const COUNTRIES = ['SE', 'DK', 'FI', 'NO'] as const;
type Country = typeof COUNTRIES[number];
type Variant = { sku: string; ean: string; title: string; priceMinor: number };
type LarkCost = {
  sku: string; recordId: string; status: 'ok' | 'duplicate'; costSekMinor: number | null; warehouseSekMinor: number | null;
  seLogisticsSekMinor: number | null; dkLogisticsSekMinor: number | null; fiLogisticsSekMinor: number | null;
  noLogisticsSekMinor: number | null; chemicalTaxSeSekMinor: number | null; copySweSekMinor: number | null;
  copyDkSekMinor: number | null; fixedFeeSekMinor: number | null; rabattSekMinor: number | null; updatedAt: string;
};
type Market = {
  currency: string; mistoreHandle: string | null; mistoreName: string | null; mistoreUrl: string | null;
  mistorePriceMinor: number | null; marketProductId: string | null; marketProductName: string | null;
  marketProductUrl: string | null; matchStatus: string; lowPriceMinor: number | null; lowMerchant: string | null;
  secondLowPriceMinor: number | null; secondLowMerchant: string | null;
  expectedPriceMinor: number | null; updatedAt: string | null; manualRefreshedAt: string | null; autoRefreshedAt: string | null;
};
type Product = { id: string; sku: string; productName: string; ean: string; createdAt: string; markets: Record<Country, Market>; variants: Record<Country, Variant[]>; larkCosts: Record<string, LarkCost> };
type Group = { key: string; primary: Product; members: Product[]; variants: Variant[] };
type MiStoreCandidate = { handle: string; name: string; url: string; priceMinor: number; currency: string; sku: string; ean: string; variantTitle: string; confidence: number };
type MarketCandidate = { id: string; name: string; url: string; previewPrice: number | null; currency: string; confidence: number };
type Collection = { handle: string; title: string; productHandles: string[]; updatedAt: string };
type CollectionJob = { handle: string; title: string; phase: 'importing' | 'pricing' | 'complete'; total: number;
  processed: number; imported: number; updated: number; priceProcessed: number; priceTotal: number; failed: number; priceErrors: number };
type ActiveVariants = { key: string; variants: Variant[]; costs: Record<string, LarkCost>; markets: Record<Country, Market>; left: number; top: number; width: number };
type Matrix = Array<Array<string | number | boolean | Date | null>>;
type ApiPayload = { error?: string; products?: Product[]; mistoreCandidates?: MiStoreCandidate[]; marketCandidates?: MarketCandidate[];
  errors?: Array<{ message: string }>; imported?: number; updated?: number; ids?: string[]; touchedIds?: string[]; collections?: Collection[]; collection?: Collection;
  processed?: number; failedHandles?: string[]; lark?: LarkStatus; synced?: number; duplicateRows?: number;
  larkWriteback?: string; larkWritebackCount?: number; writebackErrors?: string[] };
type LarkStatus = { configured: boolean; lastSyncedAt: string | null; lastError: string | null };
const currency: Record<Country, string> = { SE: 'SEK', DK: 'DKK', FI: 'EUR', NO: 'NOK' };
const locale: Record<Country, string> = { SE: 'sv-SE', DK: 'da-DK', FI: 'fi-FI', NO: 'nb-NO' };
const larkRate: Record<Country, number> = { SE: 1, DK: 1.48, FI: 11.07, NO: 1 };
const vatRate: Record<Country, number> = { SE: 1.25, DK: 1.25, FI: 1.255, NO: 1.25 };
const aliases = {
  sku: ['sku', 'artikelnummer', 'item number', 'product id', 'product code', '产品编号'],
  name: ['product name', 'title', 'produktnamn', 'product', 'name', '产品名称', '商品名称'],
  ean: ['ean', 'gtin', 'barcode', '条码'],
};
function normalizeHeader(value: unknown) { return String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' '); }
function columnIndex(headers: unknown[], names: string[], fallback = -1) {
  const normalized = headers.map(normalizeHeader);
  const exact = normalized.findIndex((name) => names.includes(name));
  return exact >= 0 ? exact : normalized.findIndex((name) => names.some((alias) => name.includes(alias))) >= 0
    ? normalized.findIndex((name) => names.some((alias) => name.includes(alias))) : fallback;
}
function parseDelimited(text: string): Matrix {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = ['\t', ';', ','].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows: Matrix = []; let row: Matrix[number] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); if (row.some((value) => String(value ?? '').trim())) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  row.push(cell); if (row.some((value) => String(value ?? '').trim())) rows.push(row);
  return rows;
}
function parsePrice(value: string) {
  let clean = value.trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (clean.includes(',') && clean.includes('.')) clean = clean.lastIndexOf(',') > clean.lastIndexOf('.') ? clean.replace(/\./g, '').replace(',', '.') : clean.replace(/,/g, '');
  else if (clean.includes(',')) clean = /,\d{1,2}$/.test(clean) ? clean.replace(',', '.') : clean.replace(/,/g, '');
  return Number(clean);
}
function money(minor: number | null, country: Country) {
  if (minor == null) return '—';
  return new Intl.NumberFormat(locale[country], { style: 'currency', currency: currency[country], maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
}
function priceRange(group: Group, country: Country) {
  const values = ownPriceValues(group, country);
  if (!values.length) return '—';
  const low = Math.min(...values); const high = Math.max(...values);
  return low === high ? money(low, country) : `${money(low, country)} – ${money(high, country)}`;
}
function ownPriceValues(group: Group, country: Country) {
  return group.members.flatMap((member) => [member.markets[country].mistorePriceMinor, ...(member.variants?.[country] ?? []).map((variant) => variant.priceMinor)]).filter((value): value is number => value != null);
}
function rangeDifference(group: Group, country: Country, marketLow: number | null) {
  const values = ownPriceValues(group, country);
  if (!values.length || marketLow == null) return null;
  const low = difference(Math.min(...values), marketLow); const high = difference(Math.max(...values), marketLow);
  if (!low || !high) return null;
  return { label: low.label === high.label ? low.label : `${low.label} – ${high.label}`, percentage: high.percentage };
}
function difference(own: number | null, market: number | null) {
  if (own == null || market == null || market <= 0) return null;
  const percentage = (own - market) / market * 100;
  return { percentage, label: `${percentage > 0 ? '+' : ''}${percentage.toFixed(1)}%` };
}
function productCosts(group: Group) {
  const records = new Map<string, LarkCost>();
  for (const member of group.members) for (const [sku, record] of Object.entries(member.larkCosts ?? {})) records.set(sku, record);
  return records;
}
function convertedCost(costSekMinor: number, country: Country) { return Math.round(costSekMinor / larkRate[country]); }
function expectedProfit(record: LarkCost, country: Country, expectedPriceMinor: number | null) {
  if (record.status !== 'ok' || record.costSekMinor == null || expectedPriceMinor == null || expectedPriceMinor <= 0) return null;
  const logistics = country === 'SE' ? record.seLogisticsSekMinor : country === 'DK' ? record.dkLogisticsSekMinor : country === 'FI' ? record.fiLogisticsSekMinor : record.noLogisticsSekMinor;
  if ([record.warehouseSekMinor, logistics, record.fixedFeeSekMinor].some((value) => value == null)) return null;
  const grossSek = expectedPriceMinor * larkRate[country];
  let profit = grossSek / vatRate[country] - record.costSekMinor - record.warehouseSekMinor! - logistics! - record.fixedFeeSekMinor! + (record.rabattSekMinor ?? 0) - grossSek * 0.03;
  if (country === 'SE') profit -= (record.chemicalTaxSeSekMinor ?? 0) + (record.copySweSekMinor ?? 0);
  if (country === 'DK') profit -= record.copyDkSekMinor ?? 0;
  return { profitMinor: country === 'DK' || country === 'FI' ? Math.round(profit / 100) * 100 : Math.round(profit / 10) * 10, margin: profit / grossSek * 100 };
}
function groupCostRange(group: Group, country: Country) {
  const all = [...productCosts(group).values()];
  const valid = all.filter((record) => record.status === 'ok' && record.costSekMinor != null);
  if (!valid.length) return { label: '—', note: all.some((record) => record.status === 'duplicate') ? 'Duplicate SKU in Lark' : 'Missing cost' };
  const values = valid.map((record) => convertedCost(record.costSekMinor!, country));
  const low = Math.min(...values); const high = Math.max(...values);
  return { label: low === high ? money(low, country) : `${money(low, country)} – ${money(high, country)}`, note: valid.length === all.length ? 'Purchase cost' : `${valid.length}/${all.length} SKUs` };
}
function groupProfitRange(group: Group, country: Country, expectedPriceMinor: number | null) {
  const values = [...productCosts(group).values()].map((record) => expectedProfit(record, country, expectedPriceMinor)).filter((value): value is NonNullable<typeof value> => value != null);
  if (!values.length) return null;
  const profits = values.map((value) => value.profitMinor); const margins = values.map((value) => value.margin);
  const lowProfit = Math.min(...profits); const highProfit = Math.max(...profits); const lowMargin = Math.min(...margins); const highMargin = Math.max(...margins);
  const amount = lowProfit === highProfit ? money(lowProfit, 'SE') : `${money(lowProfit, 'SE')} – ${money(highProfit, 'SE')}`;
  const margin = Math.round(lowMargin) === Math.round(highMargin) ? `${Math.round(lowMargin)}%` : `${Math.round(lowMargin)}% – ${Math.round(highMargin)}%`;
  return `${amount} · ${margin}`;
}
function dateLabel(value: string | null, timeZone = 'Europe/Stockholm') {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(value));
}
function escapeCsv(value: unknown) {
  const string = String(value ?? '');
  return /[",\n\r;]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
}
function groupProducts(products: Product[]): Group[] {
  const groups = new Map<string, Group>();
  for (const product of products) {
    const match = COUNTRIES.map((country) => product.markets[country].mistoreHandle ? `${country}:${product.markets[country].mistoreHandle}` : '').find(Boolean);
    const key = match ? `mistore:${match}` : `product:${product.id}`;
    const existing = groups.get(key);
    if (existing) existing.members.push(product);
    else groups.set(key, { key, primary: product, members: [product], variants: [] });
  }
  for (const group of groups.values()) {
    const variants = new Map<string, Variant>();
    for (const member of group.members) {
      if (member.sku || member.ean) variants.set(`${member.sku}|${member.ean}`, { sku: member.sku, ean: member.ean, title: '', priceMinor: member.markets.SE.mistorePriceMinor ?? 0 });
      for (const variant of member.variants?.SE ?? []) variants.set(`${variant.sku}|${variant.ean}`, variant);
    }
    group.variants = [...variants.values()];
  }
  return [...groups.values()];
}

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]); const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState(''); const [filter, setFilter] = useState('all'); const [filterCountry, setFilterCountry] = useState<Country | 'ALL'>('ALL');
  const [collections, setCollections] = useState<Collection[]>([]); const [collectionFilter, setCollectionFilter] = useState('ALL');
  const [collectionsOpen, setCollectionsOpen] = useState(false); const [collectionInput, setCollectionInput] = useState(''); const [collectionSaving, setCollectionSaving] = useState(false);
  const [collectionJob, setCollectionJob] = useState<CollectionJob | null>(null); const [collectionJobHidden, setCollectionJobHidden] = useState(false);
  const collectionSyncRef = useRef(false);
  const [page, setPage] = useState(1); const [selected, setSelected] = useState<Set<string>>(new Set()); const lastSelectedIndex = useRef<number | null>(null);
  const [refreshing, setRefreshing] = useState(false); const refreshingRef = useRef(false); const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [notice, setNotice] = useState(''); const [importOpen, setImportOpen] = useState(false);
  const [matchProduct, setMatchProduct] = useState<Product | null>(null); const [matchCountry, setMatchCountry] = useState<Country>('SE');
  const [mistoreQuery, setMistoreQuery] = useState(''); const [marketQuery, setMarketQuery] = useState('');
  const [mistoreCandidates, setMistoreCandidates] = useState<MiStoreCandidate[]>([]); const [marketCandidates, setMarketCandidates] = useState<MarketCandidate[]>([]);
  const [mistoreLoading, setMistoreLoading] = useState(false); const [marketLoading, setMarketLoading] = useState(false);
  const [manualQuery, setManualQuery] = useState(''); const [manualCandidates, setManualCandidates] = useState<MiStoreCandidate[]>([]); const [manualLoading, setManualLoading] = useState(false);
  const [matrix, setMatrix] = useState<Matrix>([]); const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState({ sku: -1, name: -1, ean: -1 }); const [pasteText, setPasteText] = useState('');
  const [expectedDraft, setExpectedDraft] = useState<Record<string, string>>({}); const fileRef = useRef<HTMLInputElement>(null);
  const [activeVariants, setActiveVariants] = useState<ActiveVariants | null>(null);
  const [lark, setLark] = useState<LarkStatus>({ configured: false, lastSyncedAt: null, lastError: null }); const [larkSyncing, setLarkSyncing] = useState(false);
  const variantCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadProducts = useCallback(async () => {
    const response = await fetch('/api/products', { cache: 'no-store' }); const data = await response.json() as ApiPayload;
    if (!response.ok) throw new Error(data.error || 'Could not load products'); setProducts(data.products ?? []); if (data.lark) setLark(data.lark);
  }, []);
  const loadCollections = useCallback(async () => {
    const response = await fetch('/api/collections', { cache: 'no-store' }); const data = await response.json() as ApiPayload;
    if (!response.ok) throw new Error(data.error || 'Could not load collections'); setCollections(data.collections ?? []);
  }, []);
  useEffect(() => { queueMicrotask(() => { void loadProducts().catch((error) => setNotice(String(error))).finally(() => setLoading(false)); }); }, [loadProducts]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadProducts().catch(() => {});
    }, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void loadProducts().catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [loadProducts]);
  useEffect(() => { queueMicrotask(() => { void loadCollections().catch((error) => setNotice(String(error))); }); }, [loadCollections]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => { const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { closeImport(); setMatchProduct(null); setCollectionsOpen(false); setActiveVariants(null); } }; document.addEventListener('keydown', dismiss); return () => document.removeEventListener('keydown', dismiss); }, []);
  useEffect(() => () => { if (variantCloseTimer.current) clearTimeout(variantCloseTimer.current); }, []);

  function cancelVariantClose() { if (variantCloseTimer.current) clearTimeout(variantCloseTimer.current); }
  function scheduleVariantClose() { cancelVariantClose(); variantCloseTimer.current = setTimeout(() => setActiveVariants(null), 180); }
  function showVariants(event: React.SyntheticEvent<HTMLElement>, group: Group) {
    cancelVariantClose();
    const rect = event.currentTarget.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 32);
    const height = Math.min(290, 44 + group.variants.length * 44);
    setActiveVariants({ key: group.key, variants: group.variants, costs: Object.fromEntries(productCosts(group)), markets: group.primary.markets,
      left: Math.max(16, Math.min(rect.right + 10, window.innerWidth - width - 16)),
      top: Math.max(16, Math.min(rect.top, window.innerHeight - height - 16)), width });
  }

  const groups = useMemo(() => groupProducts(products), [products]);
  const numbers = useMemo(() => new Map(groups.map((group, index) => [group.key, index + 1])), [groups]);
  const filtered = useMemo(() => groups.filter((group) => {
    const text = [group.primary.productName, ...group.variants.flatMap((variant) => [variant.sku, variant.ean, variant.title])].join(' ').toLowerCase();
    if (query && !query.toLowerCase().split(/\s+/).every((term) => text.includes(term))) return false;
    if (collectionFilter !== 'ALL') {
      const collection = collections.find((item) => item.handle === collectionFilter);
      if (!collection || !group.members.some((member) => member.markets.SE.mistoreHandle && collection.productHandles.includes(member.markets.SE.mistoreHandle))) return false;
    }
    const markets = (filterCountry === 'ALL' ? COUNTRIES : [filterCountry]).flatMap((country) => group.members.map((member) => member.markets[country]));
    if (filter === 'above') return markets.some((market) => market.mistorePriceMinor != null && market.lowPriceMinor != null && market.mistorePriceMinor > market.lowPriceMinor);
    if (filter === 'pending') return markets.some((market) => market.mistorePriceMinor == null || market.lowPriceMinor == null || market.matchStatus === 'pending');
    return true;
  }), [groups, query, filter, filterCountry, collectionFilter, collections]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 50)); const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * 50, safePage * 50);
  const selectedGroups = groups.filter((group) => group.members.some((member) => selected.has(member.id)));
  const allPageSelected = pageRows.length > 0 && pageRows.every((group) => group.members.every((member) => selected.has(member.id)));
  const refreshed = products.flatMap((product) => COUNTRIES.map((country) => product.markets[country]));
  const lastManual = refreshed.map((market) => market.manualRefreshedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const lastAuto = refreshed.map((market) => market.autoRefreshedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
  const beijingToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const autoCompletedToday = products.filter((product) => COUNTRIES.every((country) => {
    const refreshedAt = product.markets[country].autoRefreshedAt;
    return refreshedAt && new Date(Date.parse(refreshedAt) + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === beijingToday;
  })).length;
  const activeMatch = matchProduct ? products.find((product) => product.id === matchProduct.id) ?? matchProduct : null;

  function closeImport() { setImportOpen(false); setManualQuery(''); setManualCandidates([]); setMatrix([]); setPasteText(''); if (fileRef.current) fileRef.current.value = ''; }
  function toggleGroup(group: Group, index: number, shift: boolean) {
    const next = new Set(selected); const target = group.members.every((member) => selected.has(member.id)) ? false : true;
    const start = shift && lastSelectedIndex.current != null ? Math.min(index, lastSelectedIndex.current) : index;
    const end = shift && lastSelectedIndex.current != null ? Math.max(index, lastSelectedIndex.current) : index;
    for (let i = start; i <= end; i += 1) for (const member of filtered[i].members) {
      if (target) next.add(member.id); else next.delete(member.id);
    }
    setSelected(next); lastSelectedIndex.current = index;
  }
  function togglePage() {
    const next = new Set(selected); for (const group of pageRows) for (const member of group.members) {
      if (allPageSelected) next.delete(member.id); else next.add(member.id);
    } setSelected(next);
  }
  const refreshIds = useCallback(async (ids: string[], countries: readonly Country[] = COUNTRIES, quiet = false) => {
    const unique = [...new Set(ids)]; if (!unique.length || refreshingRef.current) return;
    refreshingRef.current = true; setRefreshing(true); setProgress({ done: 0, total: unique.length }); let errors = 0;
    try {
      try {
        const larkResponse = await fetch('/api/lark/sync', { method: 'POST' });
        if (larkResponse.ok) await loadProducts();
      } catch { /* Price refresh can continue when the cost source is temporarily unavailable. */ }
      for (const [index, id] of unique.entries()) {
        const counts = await Promise.all(countries.map(async (country) => {
          try {
            const response = await fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id], country, source: 'manual' }) });
            const data = await response.json() as ApiPayload; return data.errors?.length ?? (response.ok ? 0 : 1);
          } catch { return 1; }
        }));
        errors += counts.reduce((sum, value) => sum + value, 0); setProgress({ done: index + 1, total: unique.length });
        await loadProducts();
      }
      if (!quiet) setNotice(errors ? `Refresh finished. ${errors} country matches need review.` : `Updated ${unique.length} products.`);
    } finally { refreshingRef.current = false; setRefreshing(false); }
  }, [loadProducts]);
  async function saveExpected(group: Group, country: Country) {
    const product = group.primary;
    const key = `${product.id}:${country}`; if (!(key in expectedDraft)) return;
    const input = expectedDraft[key]; const parsed = parsePrice(input);
    if (input.trim() && (!Number.isFinite(parsed) || parsed < 0)) return setNotice('Enter a valid expected price.');
    const expectedPriceMinor = input.trim() ? Math.round(parsed * 100) : null;
    const skus = product.sku ? [product.sku] : [];
    const response = await fetch('/api/products', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: product.id, country, expectedPriceMinor, skus }) });
    const data = await response.json() as ApiPayload;
    if (!response.ok) return setNotice(data.error || 'Could not save expected price.');
    setProducts((current) => current.map((item) => item.id === product.id
      ? { ...item, markets: { ...item.markets, [country]: { ...item.markets[country], expectedPriceMinor } } }
      : item));
    setExpectedDraft((draft) => { if (draft[key] !== input) return draft; const next = { ...draft }; delete next[key]; return next; });
    if (data.larkWriteback === 'saved') setNotice(`Expected price saved to Lark for SKU ${product.sku}.`);
    else if (data.larkWriteback === 'partial') setNotice('Saved locally, but some Lark rows could not be updated.');
    else if (data.larkWriteback === 'no_matching_sku') setNotice('Saved locally. No matching SKU row was found in Lark.');
    else setNotice('Saved locally. Connect Lark to enable writeback.');
  }
  async function syncLark() {
    if (larkSyncing) return; setLarkSyncing(true);
    try {
      const response = await fetch('/api/lark/sync', { method: 'POST' }); const data = await response.json() as ApiPayload;
      if (!response.ok) throw new Error(data.error || 'Lark sync failed');
      await loadProducts(); setNotice(`Synced ${data.synced ?? 0} Lark rows${data.duplicateRows ? `; ${data.duplicateRows} duplicate SKU rows need review` : ''}.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Lark sync failed'); }
    finally { setLarkSyncing(false); }
  }
  async function lookup(source: 'mistore' | 'market', country: Country, value: string) {
    if (!value.trim()) return;
    const setLoading = source === 'mistore' ? setMistoreLoading : setMarketLoading;
    setLoading(true);
    try {
      const response = await fetch(`/api/search?source=${source}&country=${country}&q=${encodeURIComponent(value.trim())}`);
      const data = await response.json() as ApiPayload; if (!response.ok) throw new Error(data.error || 'Search failed');
      if (source === 'mistore') setMistoreCandidates(data.mistoreCandidates ?? []);
      else setMarketCandidates(data.marketCandidates ?? []);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Search failed'); }
    finally { setLoading(false); }
  }
  function openMatch(product: Product) {
    setMatchProduct(product); setMatchCountry('SE');
    const own = product.sku || product.ean || product.productName; const market = product.markets.SE.mistoreName || product.productName;
    setMistoreQuery(own); setMarketQuery(market); setMistoreCandidates([]); setMarketCandidates([]);
    void lookup('mistore', 'SE', own); void lookup('market', 'SE', market);
  }
  function changeCountry(country: Country) {
    if (!activeMatch) return; setMatchCountry(country);
    const own = activeMatch.sku || activeMatch.ean || activeMatch.productName; const market = activeMatch.markets[country].mistoreName || activeMatch.productName;
    setMistoreQuery(own); setMarketQuery(market); setMistoreCandidates([]); setMarketCandidates([]);
    void lookup('mistore', country, own); void lookup('market', country, market);
  }
  async function chooseMiStore(candidate: MiStoreCandidate) {
    if (!activeMatch) return;
    const response = await fetch('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: activeMatch.id, country: matchCountry, source: 'mistore', handle: candidate.handle, sku: candidate.sku, ean: candidate.ean }) });
    const data = await response.json() as ApiPayload; if (!response.ok) return setNotice(data.error || 'MiStore match failed');
    await loadProducts(); setNotice(`${matchCountry} MiStore product updated.`);
  }
  async function chooseMarket(candidate: MarketCandidate) {
    if (!activeMatch) return;
    const response = await fetch('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: activeMatch.id, country: matchCountry, source: 'market', productId: candidate.id, productName: candidate.name, productUrl: candidate.url }) });
    const data = await response.json() as ApiPayload; if (!response.ok) return setNotice(data.error || 'Prisjakt match failed');
    await loadProducts(); setNotice(`${matchCountry} Prisjakt product updated.`);
  }
  async function removeMatch(source: 'mistore' | 'market') {
    if (!activeMatch) return;
    const response = await fetch('/api/match', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: activeMatch.id, country: matchCountry, source }) });
    if (!response.ok) return setNotice('Could not remove this match.');
    await loadProducts(); setNotice(`${matchCountry} ${source === 'market' ? 'Prisjakt' : 'MiStore'} match removed.`);
  }
  async function searchManual() {
    if (!manualQuery.trim()) return; setManualLoading(true);
    try {
      const response = await fetch(`/api/search?source=mistore&country=SE&q=${encodeURIComponent(manualQuery)}`);
      const data = await response.json() as ApiPayload; if (!response.ok) throw new Error(data.error || 'Search failed'); setManualCandidates(data.mistoreCandidates ?? []);
      if (!data.mistoreCandidates?.length) setNotice('No MiStore products found. Try a name, SKU, EAN, or product URL.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Search failed'); }
    finally { setManualLoading(false); }
  }
  async function syncCollection(collection: Collection) {
    if (collectionSyncRef.current) return setNotice('A collection is already syncing.');
    collectionSyncRef.current = true; setCollectionJobHidden(false); setCollectionsOpen(false);
    setFilter('all'); setCollectionFilter(collection.handle); setPage(1);
    let processed = 0; let imported = 0; let updated = 0; let failed: string[] = []; let priceErrors = 0;
    const touched = new Set<string>();
    const progress = (phase: CollectionJob['phase'], priceProcessed = 0, priceTotal = 0) =>
      setCollectionJob({ handle: collection.handle, title: collection.title, phase, total: collection.productHandles.length,
        processed, imported, updated, priceProcessed, priceTotal, failed: failed.length, priceErrors });
    progress('importing');
    try {
      const importChunk = async (body: { handle: string; offset?: number; handles?: string[] }) => {
        const response = await fetch('/api/collections/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json() as ApiPayload;
        if (!response.ok) throw new Error(data.error || 'Collection import failed');
        imported += data.imported ?? 0; updated += data.updated ?? 0;
        for (const id of data.ids ?? []) touched.add(id);
        return data.failedHandles ?? [];
      };
      for (let offset = 0; offset < collection.productHandles.length; offset += 8) {
        const handles = collection.productHandles.slice(offset, offset + 8);
        try { failed.push(...await importChunk({ handle: collection.handle, offset })); }
        catch { failed.push(...handles); }
        processed += handles.length; progress('importing');
        await loadProducts();
      }
      if (failed.length) {
        const retry = failed; failed = [];
        for (let index = 0; index < retry.length; index += 8) {
          const handles = retry.slice(index, index + 8);
          try { failed.push(...await importChunk({ handle: collection.handle, handles })); }
          catch { failed.push(...handles); }
          progress('importing');
        }
        await loadProducts();
      }
      const ids = [...touched]; progress('pricing', 0, ids.length);
      for (let index = 0; index < ids.length; index += 1) {
        const results = await Promise.all(ids.slice(index, index + 1).map(async (id) =>
          Promise.all(COUNTRIES.map(async (country) => {
            try {
              const response = await fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ids: [id], country, source: 'manual' }) });
              const data = await response.json() as ApiPayload;
              return data.errors?.length ?? (response.ok ? 0 : 1);
            } catch { return 1; }
          }))));
        priceErrors += results.flat(2).reduce((sum, count) => sum + count, 0);
        progress('pricing', index + 1, ids.length);
        await loadProducts();
      }
      progress('complete', ids.length, ids.length);
    } catch (error) { progress('complete', 0, touched.size); setNotice(error instanceof Error ? error.message : 'Collection sync failed'); }
    finally { collectionSyncRef.current = false; }
  }
  async function saveCollection(input = collectionInput) {
    if (!input.trim() || collectionSyncRef.current) return; setCollectionSaving(true);
    try {
      const response = await fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: input.trim() }) });
      const data = await response.json() as ApiPayload; if (!response.ok) throw new Error(data.error || 'Could not add collection');
      setCollectionInput(''); await loadCollections();
      if (data.collection) void syncCollection(data.collection);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not add collection'); }
    finally { setCollectionSaving(false); }
  }
  async function removeCollection(handle: string) {
    const response = await fetch('/api/collections', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle }) });
    if (!response.ok) return setNotice('Could not remove collection');
    if (collectionFilter === handle) setCollectionFilter('ALL'); await loadCollections();
  }
  async function addCandidate(candidate: MiStoreCandidate) {
    const response = await fetch('/api/products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ products: [{ sku: candidate.sku, productName: candidate.name, ean: candidate.ean }] }) });
    const data = await response.json() as ApiPayload; if (!response.ok) return setNotice(data.error || 'Could not add product');
    closeImport(); await loadProducts(); setNotice(data.imported ? 'Product added. Looking up four markets.' : 'Existing product updated.');
    void refreshIds(data.touchedIds ?? data.ids ?? [], COUNTRIES, true);
  }
  function setParsedMatrix(rows: Matrix) {
    setMatrix(rows);
    const first = rows[0] ?? [];
    const detected = first.some((value) => Object.values(aliases).flat().includes(normalizeHeader(value)));
    setHasHeader(detected);
    setColumns({ sku: columnIndex(first, aliases.sku, detected ? -1 : 0), name: columnIndex(first, aliases.name, detected ? -1 : first.length > 1 ? 1 : -1), ean: columnIndex(first, aliases.ean, detected ? -1 : first.length > 2 ? 2 : -1) });
  }
  async function chooseFile(file?: File) {
    if (!file) return;
    try {
      const rows = file.name.toLowerCase().endsWith('.csv') || file.name.toLowerCase().endsWith('.tsv') ? parseDelimited(await file.text()) : await readXlsxFile(file) as Matrix;
      if (!rows.length) throw new Error('The file contains no rows');
      setParsedMatrix(rows); setNotice(`Read ${rows.length} rows from ${file.name}. Review the column mapping before importing.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not read the file'); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  }
  async function importRows() {
    const start = hasHeader ? 1 : 0;
    const items = matrix.slice(start).map((row) => ({
      sku: columns.sku >= 0 ? String(row[columns.sku] ?? '').trim() : '',
      productName: columns.name >= 0 ? String(row[columns.name] ?? '').trim() : '',
      ean: columns.ean >= 0 ? String(row[columns.ean] ?? '').trim() : '',
    })).filter((item) => item.sku || item.productName || item.ean);
    if (!items.length) return setNotice('Choose at least one populated SKU, name, or EAN column.');
    let imported = 0; let updated = 0; const touchedIds: string[] = [];
    try {
      for (let index = 0; index < items.length; index += 30) {
        const response = await fetch('/api/products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ products: items.slice(index, index + 30) }) });
        const data = await response.json() as ApiPayload; if (!response.ok) throw new Error(data.error || 'Import failed');
        imported += data.imported ?? 0; updated += data.updated ?? 0; touchedIds.push(...(data.touchedIds ?? []));
      }
      closeImport(); await loadProducts(); setNotice(`Imported ${imported} new products and updated ${updated} existing products. Price lookup started.`);
      void refreshIds(touchedIds, COUNTRIES, true);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Import failed'); await loadProducts(); }
  }
  async function deleteSelected() {
    if (!selected.size || !window.confirm(`Delete ${selected.size} selected product records?`)) return;
    const ids = [...selected];
    for (let index = 0; index < ids.length; index += 10) {
      const response = await fetch('/api/products', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ids.slice(index, index + 10) }) });
      if (!response.ok) { await loadProducts(); return setNotice('Could not delete all selected products.'); }
    }
    setSelected(new Set()); await loadProducts();
  }
  const exportGroups = selectedGroups;
  const exportHeader = ['No.', 'SKU', 'Product Name', 'EAN',
    ...COUNTRIES.flatMap((country) => [`${country} MiStore Price`, `${country} Market Lowest`, `${country} Market Second Lowest`, `${country} Expected Price`, `${country} Cost Price`]),
    ...COUNTRIES.flatMap((country) => [`${country} Lowest Merchant`, `${country} Second Lowest Merchant`, `${country} MiStore URL`, `${country} Prisjakt URL`, `${country} Last Manual Refresh`, `${country} Last Auto Refresh`])];
  const exportRows = exportGroups.flatMap((group) => {
    const variants = group.variants.length ? group.variants : [{ sku: group.primary.sku, ean: group.primary.ean, title: '', priceMinor: group.primary.markets.SE.mistorePriceMinor ?? 0 }];
    return variants.map((variant, variantIndex) => {
      const baseName = group.primary.markets.SE.mistoreName || group.primary.productName;
      const productName = variant.title && !/^default title$/i.test(variant.title.trim()) ? `${baseName} - ${variant.title}` : baseName;
      const prices = COUNTRIES.flatMap((country) => {
        const market = group.primary.markets[country];
        const countryVariant = group.members.flatMap((member) => member.variants[country] ?? [])
          .find((item) => (variant.sku && item.sku === variant.sku) || (variant.ean && item.ean === variant.ean));
        const mistorePrice = countryVariant?.priceMinor ?? market.mistorePriceMinor;
        const larkCost = productCosts(group).get(variant.sku.trim().toLowerCase());
        return [mistorePrice == null ? '' : mistorePrice / 100, market.lowPriceMinor == null ? '' : market.lowPriceMinor / 100,
          market.secondLowPriceMinor == null ? '' : market.secondLowPriceMinor / 100,
          market.expectedPriceMinor == null ? '' : market.expectedPriceMinor / 100,
          larkCost?.status === 'ok' && larkCost.costSekMinor != null ? convertedCost(larkCost.costSekMinor, country) / 100 : ''];
      });
      const sources = COUNTRIES.flatMap((country) => {
        const market = group.primary.markets[country];
        return [market.lowMerchant ?? '', market.secondLowMerchant ?? '', market.mistoreUrl ?? '', market.marketProductUrl ?? '', market.manualRefreshedAt ?? '', market.autoRefreshedAt ?? ''];
      });
      return [`${numbers.get(group.key) ?? ''}${variants.length > 1 ? `.${variantIndex + 1}` : ''}`, variant.sku, productName, variant.ean, ...prices, ...sources];
    });
  });
  function exportCsv() {
    if (!exportGroups.length) return; const csv = [exportHeader, ...exportRows].map((row) => row.map(escapeCsv).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `PriceDesk_${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">P</span><strong>PriceDesk</strong></div><div className="topbar-actions">
      <button className="button" onClick={() => setCollectionsOpen(true)}>Collections</button>
      <button className="button" onClick={() => void syncLark()} disabled={larkSyncing || !lark.configured}>{larkSyncing ? 'Syncing Lark…' : 'Sync Lark costs'}</button>
      <button className="button" onClick={exportCsv} disabled={!selectedGroups.length}>Export CSV ({selectedGroups.length})</button>
      <button className="button primary" onClick={() => setImportOpen(true)}>Import products</button>
    </div></header>
    <section className="toolbar">
      <label className="search-box"><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search SKU, product name or EAN" /></label>
      <select aria-label="Price status" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}><option value="all">All prices</option><option value="above">Above market</option><option value="pending">Needs review</option></select>
      <select aria-label="Country filter" value={filterCountry} onChange={(event) => { setFilterCountry(event.target.value as Country | 'ALL'); setPage(1); }}><option value="ALL">All countries</option>{COUNTRIES.map((country) => <option key={country}>{country}</option>)}</select>
      <select aria-label="Collection filter" value={collectionFilter} onChange={(event) => { setCollectionFilter(event.target.value); setPage(1); }}><option value="ALL">All collections</option>{collections.map((collection) => <option key={collection.handle} value={collection.handle}>{collection.title}</option>)}</select>
      <button className="button" disabled={refreshing || !selected.size} onClick={() => void refreshIds([...selected])}>{refreshing ? `Refreshing ${progress.done}/${progress.total}` : `Refresh selected (${selectedGroups.length})`}</button>
      {selected.size > 0 && <button className="button" onClick={() => { setSelected(new Set()); lastSelectedIndex.current = null; }}>Clear selection</button>}
      {selected.size > 0 && <button className="delete-button" onClick={deleteSelected}>Delete selected</button>}
      <div className="toolbar-meta"><span>Lark: {lark.configured ? dateLabel(lark.lastSyncedAt) : 'Not connected'}</span><span>Manual (Stockholm): {dateLabel(lastManual)}</span><span>Automatic (Beijing): {dateLabel(lastAuto, 'Asia/Shanghai')} · {autoCompletedToday}/{products.length} checked today</span></div>
      <div className="pager"><span>{filtered.length ? `${(safePage - 1) * 50 + 1}–${Math.min(safePage * 50, filtered.length)}` : '0'} / {filtered.length}</span><button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page">‹</button><span>{safePage} / {pageCount}</span><button disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)} aria-label="Next page">›</button></div>
    </section>
    <section className="grid-wrap" onScrollCapture={() => setActiveVariants(null)}><table className="price-grid"><colgroup><col style={{ width: 36 }}/><col style={{ width: 235 }}/>{COUNTRIES.flatMap((country) => [<col key={`${country}-own`} style={{ width: 145 }}/>, <col key={`${country}-market`} style={{ width: 145 }}/>, <col key={`${country}-second`} style={{ width: 145 }}/>, <col key={`${country}-expected`} style={{ width: 145 }}/>, <col key={`${country}-cost`} style={{ width: 145 }}/>])}<col style={{ width: 126 }}/></colgroup><thead><tr>
      <th rowSpan={2} className="check"><input aria-label="Select current page" type="checkbox" checked={allPageSelected} onChange={togglePage}/></th><th rowSpan={2} className="product-head">No. / SKU / Product</th>
      {COUNTRIES.map((country) => <th key={country} colSpan={5} className="country-head">{country} <small>({currency[country]})</small></th>)}<th rowSpan={2} className="action-head">Actions</th>
    </tr><tr>{COUNTRIES.flatMap((country) => [<th key={`${country}-own`}>MiStore Price</th>, <th key={`${country}-market`}>Lowest Price<br/>in Market</th>, <th key={`${country}-second`}>Second Lowest<br/>Price</th>, <th key={`${country}-expected`}>Expected Price</th>, <th key={`${country}-cost`}>Cost Price</th>])}</tr></thead><tbody>
      {loading ? <tr><td colSpan={23} className="state-row">Loading products…</td></tr> : !pageRows.length ? <tr><td colSpan={23} className="state-row">No products match this filter.</td></tr> : pageRows.map((group) => {
        const product = group.primary; const groupIndex = filtered.findIndex((item) => item.key === group.key); const checked = group.members.every((member) => selected.has(member.id));
        return <tr key={group.key}><td className="check"><input type="checkbox" checked={checked} readOnly onClick={(event) => toggleGroup(group, groupIndex, event.shiftKey)} aria-label={`Select product ${numbers.get(group.key)}`}/></td>
          <td className="product-cell"><strong><span className="row-number">{numbers.get(group.key)}.</span> {product.sku || group.variants[0]?.sku || '—'}</strong><span title={product.markets.SE.mistoreName || product.productName}>{product.markets.SE.mistoreName || product.productName}</span>
            {group.variants.length > 1 ? <button type="button" className="variant-trigger" aria-expanded={activeVariants?.key === group.key} onPointerEnter={(event) => showVariants(event, group)} onPointerLeave={scheduleVariantClose} onFocus={(event) => showVariants(event, group)} onBlur={scheduleVariantClose} onClick={(event) => showVariants(event, group)}>Variants ({group.variants.length})</button> : <small>{product.ean || group.variants[0]?.ean || 'No EAN'}</small>}
          </td>
          {COUNTRIES.flatMap((country) => {
            const market = product.markets[country]; const ownDiff = rangeDifference(group, country, market.lowPriceMinor); const key = `${product.id}:${country}`;
            const draft = expectedDraft[key]; const draftPrice = draft?.trim() ? parsePrice(draft) : null;
            const expectedPriceMinor = key in expectedDraft ? draftPrice != null && Number.isFinite(draftPrice) && draftPrice >= 0 ? Math.round(draftPrice * 100) : null : market.expectedPriceMinor;
            const expectedDiff = difference(expectedPriceMinor, market.lowPriceMinor);
            const profit = groupProfitRange(group, country, expectedPriceMinor); const cost = groupCostRange(group, country);
            const tooltip = `Manual (Stockholm): ${dateLabel(market.manualRefreshedAt)} | Automatic (Beijing): ${dateLabel(market.autoRefreshedAt, 'Asia/Shanghai')}`;
            return [<td key={`${country}-own`} className="price-cell" title={tooltip}><a className="price-link" href={market.mistoreUrl || undefined} target="_blank" rel="noreferrer" title={priceRange(group, country)}>{priceRange(group, country)}</a><small className={ownDiff ? ownDiff.percentage > 0 ? 'bad' : 'good' : 'neutral'}>{ownDiff?.label ?? '—'}</small></td>,
              <td key={`${country}-market`} className="price-cell" title={tooltip}>{market.lowPriceMinor != null && market.marketProductUrl
                ? <a className="price-link" href={market.marketProductUrl} target="_blank" rel="noreferrer">{money(market.lowPriceMinor, country)}</a>
                : <span className="price-link">—</span>}<small className="merchant" title={market.lowMerchant ?? ''}>{market.lowMerchant || 'Not matched'}</small></td>,
              <td key={`${country}-second`} className="price-cell" title={tooltip}>{market.secondLowPriceMinor != null && market.marketProductUrl
                ? <a className="price-link" href={market.marketProductUrl} target="_blank" rel="noreferrer">{money(market.secondLowPriceMinor, country)}</a>
                : <span className="price-link">—</span>}<small className="merchant" title={market.secondLowMerchant ?? ''}>{market.secondLowMerchant || 'Not available'}</small></td>,
              <td key={`${country}-expected`} className="price-cell expected-cell"><input aria-label={`${country} Expected Price for product ${numbers.get(group.key)}`} value={key in expectedDraft ? expectedDraft[key] : market.expectedPriceMinor == null ? '' : String(market.expectedPriceMinor / 100)} onChange={(event) => setExpectedDraft((draft) => ({ ...draft, [key]: event.target.value }))} onBlur={() => void saveExpected(group, country)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} placeholder="—"/><small className={expectedDiff ? expectedDiff.percentage > 0 ? 'bad' : 'good' : 'neutral'}>{expectedDiff?.label ?? '—'}</small><small className={profit?.startsWith('-') ? 'bad profit-line' : profit ? 'good profit-line' : 'neutral profit-line'}>{profit ?? 'Profit unavailable'}</small></td>,
              <td key={`${country}-cost`} className="price-cell"><span className="price-link no-link">{cost.label}</span><small className="neutral">{cost.note}</small></td>];
          })}<td className="action-cell"><button className="match-button" onClick={() => openMatch(product)}>Match / Edit</button></td>
        </tr>;
      })}
    </tbody></table></section>
    {activeVariants && createPortal(<div className="variant-popover-floating" role="tooltip" style={{ left: activeVariants.left, top: activeVariants.top, width: activeVariants.width }} onPointerEnter={cancelVariantClose} onPointerLeave={scheduleVariantClose}>{activeVariants.variants.map((variant, index) => {
      const cost = activeVariants.costs[variant.sku.trim().toLowerCase()];
      return <div key={`${variant.sku}|${variant.ean}|${index}`}><strong>{variant.title || `Variant ${index + 1}`}</strong><span>SKU {variant.sku || '—'} · EAN {variant.ean || '—'}</span><span>{cost?.status === 'ok' && cost.costSekMinor != null ? `Cost ${money(cost.costSekMinor, 'SE')}` : cost?.status === 'duplicate' ? 'Duplicate SKU in Lark' : 'Cost missing in Lark'}</span><span>{COUNTRIES.map((country) => { const result = cost ? expectedProfit(cost, country, activeVariants.markets[country].expectedPriceMinor) : null; return `${country} ${result ? `${money(result.profitMinor, 'SE')} / ${Math.round(result.margin)}%` : '—'}`; }).join(' · ')}</span></div>;
    })}</div>, document.body)}
    {collectionJob && <aside className={`sync-progress ${collectionJobHidden ? 'collapsed' : ''}`} aria-live="polite">{collectionJobHidden
      ? <button className="sync-show" onClick={() => setCollectionJobHidden(false)}>{collectionJob.phase === 'complete' ? 'Collection sync finished' : `Syncing ${collectionJob.title}`} · Show</button>
      : <><div className="sync-progress-head"><strong>{collectionJob.title}</strong><button onClick={() => setCollectionJobHidden(true)}>Hide</button></div>
        <p>{collectionJob.phase === 'importing' ? `Importing products: ${collectionJob.processed} / ${collectionJob.total}` : collectionJob.phase === 'pricing'
          ? `Refreshing four-country prices: ${collectionJob.priceProcessed} / ${collectionJob.priceTotal}`
          : `Complete: ${collectionJob.imported} added, ${collectionJob.updated} updated`}</p>
        <progress value={collectionJob.phase === 'importing' ? collectionJob.processed : collectionJob.priceProcessed}
          max={collectionJob.phase === 'importing' ? Math.max(1, collectionJob.total) : Math.max(1, collectionJob.priceTotal)}/>
        {collectionJob.phase === 'complete' && <small>{collectionJob.failed ? `${collectionJob.failed} products could not be imported. ` : ''}{collectionJob.priceErrors ? `${collectionJob.priceErrors} country prices need review.` : 'All available prices checked.'}</small>}
        {collectionJob.phase === 'complete' && <button className="sync-dismiss" onClick={() => setCollectionJob(null)}>Dismiss</button>}</>}
    </aside>}
    {notice && <div className="toast"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
    {collectionsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCollectionsOpen(false); }}><section className="modal collections-modal"><header><div><h2>Selected MiStore collections</h2><p>Add only the collections your team uses. Product membership comes from MiStore.se.</p></div><button className="close" onClick={() => setCollectionsOpen(false)}>Close</button></header>
      <div className="manual-search"><input value={collectionInput} onChange={(event) => setCollectionInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveCollection(); }} placeholder="MiStore.se collection URL or handle"/><button className="button primary" onClick={() => void saveCollection()} disabled={collectionSaving || collectionSyncRef.current}>{collectionSaving ? 'Reading…' : 'Add / sync'}</button></div>
      <div className="collection-list">{collections.length ? collections.map((collection) => <div key={collection.handle} className="collection-item"><div><strong>{collection.title}</strong><small>{collection.productHandles.length} products · Updated {dateLabel(collection.updatedAt)} Stockholm</small></div><div><button className="button" onClick={() => void saveCollection(collection.handle)} disabled={collectionSaving || collectionSyncRef.current}>Sync products</button><button className="remove-match" onClick={() => void removeCollection(collection.handle)} disabled={collectionSyncRef.current}>Remove</button></div></div>) : <p className="candidate-empty">No collections selected yet.</p>}</div>
    </section></div>}
    {importOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeImport(); }}><section className="modal import-modal"><header><div><h2>Import products</h2><p>Search MiStore by SKU, name, EAN, or product URL. Choose the correct product.</p></div><button className="close" onClick={closeImport}>Close</button></header>
      <div className="manual-search"><input value={manualQuery} onChange={(event) => setManualQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchManual(); }} placeholder="SKU, name, EAN or MiStore URL"/><button className="button primary" onClick={searchManual} disabled={manualLoading}>{manualLoading ? 'Searching…' : 'Search MiStore'}</button></div>
      {!!manualCandidates.length && <div className="candidate-list">{manualCandidates.map((candidate) => <button key={`${candidate.handle}|${candidate.sku}`} className="candidate" onClick={() => void addCandidate(candidate)}><div><strong>{candidate.name}</strong><small>SKU {candidate.sku || '—'} · EAN {candidate.ean || '—'} · {candidate.variantTitle}</small></div><span>{money(candidate.priceMinor, 'SE')}</span></button>)}</div>}
      <div className="import-divider"><span>Or import a file / pasted rows</span></div><div className="batch-import"><input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv" hidden onChange={(event) => void chooseFile(event.target.files?.[0])}/><button className="button" onClick={() => fileRef.current?.click()}>Choose Excel / CSV</button><textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder={'SKU\tProduct Name\tEAN'}/><button className="button" onClick={() => setParsedMatrix(parseDelimited(pasteText))}>Read pasted rows</button></div>
      {!!matrix.length && <div className="mapping"><div><label className="header-toggle"><input type="checkbox" checked={hasHeader} onChange={(event) => setHasHeader(event.target.checked)}/> First row contains column names</label><p className="import-preview">{Math.max(0, matrix.length - (hasHeader ? 1 : 0))} data rows · Preview: {matrix.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 2).map((row) => row.join(' | ')).join(' / ')}</p><div className="mapping-fields">{(['sku', 'name', 'ean'] as const).map((field) => <label key={field}>{field === 'name' ? 'Product Name' : field.toUpperCase()}<select value={columns[field]} onChange={(event) => setColumns({ ...columns, [field]: Number(event.target.value) })}><option value={-1}>Do not use</option>{(matrix[0] ?? []).map((value, index) => <option key={index} value={index}>{hasHeader ? String(value || `Column ${index + 1}`) : `Column ${index + 1}`}</option>)}</select></label>)}</div></div><button className="button primary" onClick={importRows}>Import rows</button></div>}
    </section></div>}
    {activeMatch && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMatchProduct(null); }}><section className="modal match-modal"><header><div><h2>Match or edit products</h2><p>{activeMatch.productName} · {activeMatch.sku || activeMatch.ean}</p></div><button className="close" onClick={() => setMatchProduct(null)}>Close</button></header>
      <nav className="country-tabs">{COUNTRIES.map((country) => <button key={country} className={matchCountry === country ? 'active' : ''} onClick={() => changeCountry(country)}>{country}</button>)}</nav>
      <div className="match-columns"><section><h3>MiStore product</h3><p className="current-match">Current: {activeMatch.markets[matchCountry].mistoreName || 'Not matched'}</p><div className="match-search"><input value={mistoreQuery} onChange={(event) => setMistoreQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void lookup('mistore', matchCountry, mistoreQuery); }} placeholder="Name, SKU, EAN or MiStore URL"/><button className="button" onClick={() => void lookup('mistore', matchCountry, mistoreQuery)}>Search</button></div><button className="remove-match" onClick={() => void removeMatch('mistore')} disabled={!activeMatch.markets[matchCountry].mistoreHandle}>Remove MiStore match</button><div className="candidate-list">{mistoreLoading ? <p className="candidate-empty">Searching…</p> : mistoreCandidates.length ? mistoreCandidates.map((candidate) => <button key={`${candidate.handle}|${candidate.sku}`} className="candidate" onClick={() => void chooseMiStore(candidate)}><div><strong>{candidate.name}</strong><small>SKU {candidate.sku || '—'} · EAN {candidate.ean || '—'}</small></div><span>{money(candidate.priceMinor, matchCountry)}</span></button>) : <p className="candidate-empty">No results. Try a broader name or paste the product URL.</p>}</div></section>
      <section><h3>Prisjakt product</h3><p className="current-match">Current: {activeMatch.markets[matchCountry].marketProductName || 'Not matched'}</p><div className="match-search"><input value={marketQuery} onChange={(event) => setMarketQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void lookup('market', matchCountry, marketQuery); }} placeholder="Name, EAN, product URL or ID"/><button className="button" onClick={() => void lookup('market', matchCountry, marketQuery)}>Search</button></div><button className="remove-match" onClick={() => void removeMatch('market')} disabled={!activeMatch.markets[matchCountry].marketProductId}>Remove Prisjakt match</button><div className="candidate-list">{marketLoading ? <p className="candidate-empty">Searching…</p> : marketCandidates.length ? marketCandidates.map((candidate) => <button key={candidate.id} className="candidate" onClick={() => void chooseMarket(candidate)}><div><strong>{candidate.name}</strong><small>Product ID {candidate.id} · {candidate.previewPrice ?? '—'} {candidate.currency}</small></div><span>{candidate.confidence}%</span></button>) : <p className="candidate-empty">No results. Try the EAN or paste the Prisjakt product page URL.</p>}</div></section></div>
      <footer className="modal-footer"><button className="button" onClick={() => void refreshIds([activeMatch.id], [matchCountry])}>Refresh {matchCountry} only</button></footer>
    </section></div>}
  </main>;
}
