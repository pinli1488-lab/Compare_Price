'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import readXlsxFile from 'read-excel-file';
import writeXlsxFile from 'write-excel-file';

const COUNTRIES = ['SE', 'DK', 'FI', 'NO'] as const;
type Country = typeof COUNTRIES[number];
type Variant = { sku: string; ean: string; title: string; priceMinor: number };
type Market = {
  currency: string; mistoreHandle: string | null; mistoreName: string | null; mistoreUrl: string | null;
  mistorePriceMinor: number | null; marketProductId: string | null; marketProductName: string | null;
  marketProductUrl: string | null; matchStatus: string; lowPriceMinor: number | null; lowMerchant: string | null;
  expectedPriceMinor: number | null; updatedAt: string | null; manualRefreshedAt: string | null; autoRefreshedAt: string | null;
};
type Product = { id: string; sku: string; productName: string; ean: string; createdAt: string; markets: Record<Country, Market>; variants: Record<Country, Variant[]> };
type Group = { key: string; primary: Product; members: Product[]; variants: Variant[] };
type MiStoreCandidate = { handle: string; name: string; url: string; priceMinor: number; currency: string; sku: string; ean: string; variantTitle: string; confidence: number };
type MarketCandidate = { id: string; name: string; url: string; previewPrice: number | null; currency: string; confidence: number };
type Collection = { handle: string; title: string; productHandles: string[]; updatedAt: string };
type Matrix = Array<Array<string | number | boolean | Date | null>>;
type ApiPayload = { error?: string; products?: Product[]; mistoreCandidates?: MiStoreCandidate[]; marketCandidates?: MarketCandidate[];
  errors?: Array<{ message: string }>; imported?: number; updated?: number; ids?: string[]; touchedIds?: string[]; collections?: Collection[]; collection?: Collection };
const currency: Record<Country, string> = { SE: 'SEK', DK: 'DKK', FI: 'EUR', NO: 'NOK' };
const locale: Record<Country, string> = { SE: 'sv-SE', DK: 'da-DK', FI: 'fi-FI', NO: 'nb-NO' };
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
function dateLabel(value: string | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Stockholm' }).format(new Date(value));
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
  const [page, setPage] = useState(1); const [selected, setSelected] = useState<Set<string>>(new Set()); const lastSelectedIndex = useRef<number | null>(null);
  const [refreshing, setRefreshing] = useState(false); const refreshingRef = useRef(false); const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [notice, setNotice] = useState(''); const [exportOpen, setExportOpen] = useState(false); const [importOpen, setImportOpen] = useState(false);
  const [matchProduct, setMatchProduct] = useState<Product | null>(null); const [matchCountry, setMatchCountry] = useState<Country>('SE');
  const [mistoreQuery, setMistoreQuery] = useState(''); const [marketQuery, setMarketQuery] = useState('');
  const [mistoreCandidates, setMistoreCandidates] = useState<MiStoreCandidate[]>([]); const [marketCandidates, setMarketCandidates] = useState<MarketCandidate[]>([]);
  const [mistoreLoading, setMistoreLoading] = useState(false); const [marketLoading, setMarketLoading] = useState(false);
  const [manualQuery, setManualQuery] = useState(''); const [manualCandidates, setManualCandidates] = useState<MiStoreCandidate[]>([]); const [manualLoading, setManualLoading] = useState(false);
  const [matrix, setMatrix] = useState<Matrix>([]); const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState({ sku: -1, name: -1, ean: -1 }); const [pasteText, setPasteText] = useState('');
  const [expectedDraft, setExpectedDraft] = useState<Record<string, string>>({}); const fileRef = useRef<HTMLInputElement>(null);

  const loadProducts = useCallback(async () => {
    const response = await fetch('/api/products', { cache: 'no-store' }); const data = await response.json() as ApiPayload;
    if (!response.ok) throw new Error(data.error || 'Could not load products'); setProducts(data.products ?? []);
  }, []);
  const loadCollections = useCallback(async () => {
    const response = await fetch('/api/collections', { cache: 'no-store' }); const data = await response.json() as ApiPayload;
    if (!response.ok) throw new Error(data.error || 'Could not load collections'); setCollections(data.collections ?? []);
  }, []);
  useEffect(() => { queueMicrotask(() => { void loadProducts().catch((error) => setNotice(String(error))).finally(() => setLoading(false)); }); }, [loadProducts]);
  useEffect(() => { queueMicrotask(() => { void loadCollections().catch((error) => setNotice(String(error))); }); }, [loadCollections]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => window.clearTimeout(timer); }, [notice]);
  useEffect(() => { const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { closeImport(); setMatchProduct(null); setExportOpen(false); setCollectionsOpen(false); } }; document.addEventListener('keydown', dismiss); return () => document.removeEventListener('keydown', dismiss); }, []);

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
      for (const [index, id] of unique.entries()) {
        const counts = await Promise.all(countries.map(async (country) => {
          try {
            const response = await fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id], country, source: 'manual' }) });
            const data = await response.json() as ApiPayload; return data.errors?.length ?? (response.ok ? 0 : 1);
          } catch { return 1; }
        }));
        errors += counts.reduce((sum, value) => sum + value, 0); setProgress({ done: index + 1, total: unique.length });
      }
      await loadProducts();
      if (!quiet) setNotice(errors ? `Refresh finished. ${errors} country matches need review.` : `Updated ${unique.length} products.`);
    } finally { refreshingRef.current = false; setRefreshing(false); }
  }, [loadProducts]);
  async function saveExpected(product: Product, country: Country) {
    const key = `${product.id}:${country}`; if (!(key in expectedDraft)) return;
    const input = expectedDraft[key]; const parsed = parsePrice(input);
    if (input.trim() && (!Number.isFinite(parsed) || parsed < 0)) return setNotice('Enter a valid expected price.');
    const response = await fetch('/api/products', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: product.id, country, expectedPriceMinor: input.trim() ? Math.round(parsed * 100) : null }) });
    if (!response.ok) return setNotice('Could not save expected price.');
    setExpectedDraft((draft) => { const next = { ...draft }; delete next[key]; return next; }); await loadProducts();
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
  async function saveCollection(input = collectionInput) {
    if (!input.trim()) return; setCollectionSaving(true);
    try {
      const response = await fetch('/api/collections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: input.trim() }) });
      const data = await response.json() as ApiPayload; if (!response.ok) throw new Error(data.error || 'Could not add collection');
      setCollectionInput(''); await loadCollections(); setNotice(`${data.collection?.title || 'Collection'} updated with ${data.collection?.productHandles.length ?? 0} products.`);
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
  const exportHeader = ['No.', 'SKU(s)', 'Product', 'EAN(s)', ...COUNTRIES.flatMap((country) => [`${country} MiStore Price`, `${country} Market Lowest`, `${country} Lowest Merchant`, `${country} Expected Price`, `${country} MiStore URL`, `${country} Prisjakt URL`, `${country} Last Manual Refresh`, `${country} Last Auto Refresh`])];
  const exportRows = exportGroups.map((group) => [numbers.get(group.key) ?? '', group.variants.map((variant) => variant.sku).filter(Boolean).join('; '), group.primary.markets.SE.mistoreName || group.primary.productName, group.variants.map((variant) => variant.ean).filter(Boolean).join('; '), ...COUNTRIES.flatMap((country) => {
    const market = group.primary.markets[country]; return [priceRange(group, country), market.lowPriceMinor == null ? '' : market.lowPriceMinor / 100,
      market.lowMerchant ?? '', market.expectedPriceMinor == null ? '' : market.expectedPriceMinor / 100, market.mistoreUrl ?? '', market.marketProductUrl ?? '', market.manualRefreshedAt ?? '', market.autoRefreshedAt ?? ''];
  })]);
  function exportCsv() {
    if (!exportGroups.length) return; const csv = [exportHeader, ...exportRows].map((row) => row.map(escapeCsv).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `PriceDesk_${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); setExportOpen(false);
  }
  async function exportExcel() {
    if (!exportGroups.length) return;
    const rows = [exportHeader, ...exportRows].map((row, index) => row.map((value) => ({ value, type: typeof value === 'number' ? Number : String, fontWeight: index === 0 ? 'bold' as const : undefined, backgroundColor: index === 0 ? '#202020' : undefined, color: index === 0 ? '#ffffff' : '#171717' })));
    try { await writeXlsxFile(rows, { fileName: `PriceDesk_${new Date().toISOString().slice(0, 10)}.xlsx`, stickyRowsCount: 1 }); setExportOpen(false); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Excel export failed'); }
  }
  return <main className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">P</span><strong>PriceDesk</strong></div><div className="topbar-actions">
      <button className="button" onClick={() => setCollectionsOpen(true)}>Collections</button>
      <div className="dropdown-wrap"><button className="button" onClick={() => setExportOpen(!exportOpen)} disabled={!selectedGroups.length}>Export selected ({selectedGroups.length})</button>
        {exportOpen && <div className="dropdown"><button onClick={exportExcel}>Excel (.xlsx)</button><button onClick={exportCsv}>CSV (.csv)</button></div>}</div>
      <button className="button primary" onClick={() => setImportOpen(true)}>Import products</button>
    </div></header>
    <section className="toolbar">
      <label className="search-box"><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Search SKU, product name or EAN" /></label>
      <select aria-label="Price status" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1); }}><option value="all">All prices</option><option value="above">Above market</option><option value="pending">Needs review</option></select>
      <select aria-label="Country filter" value={filterCountry} onChange={(event) => { setFilterCountry(event.target.value as Country | 'ALL'); setPage(1); }}><option value="ALL">All countries</option>{COUNTRIES.map((country) => <option key={country}>{country}</option>)}</select>
      <select aria-label="Collection filter" value={collectionFilter} onChange={(event) => { setCollectionFilter(event.target.value); setPage(1); }}><option value="ALL">All collections</option>{collections.map((collection) => <option key={collection.handle} value={collection.handle}>{collection.title}</option>)}</select>
      <button className="button" disabled={refreshing || !selected.size} onClick={() => void refreshIds([...selected])}>{refreshing ? `Refreshing ${progress.done}/${progress.total}` : `Refresh selected (${selectedGroups.length})`}</button>
      {selected.size > 0 && <button className="delete-button" onClick={deleteSelected}>Delete selected</button>}
      <div className="toolbar-meta"><span>Manual (Stockholm): {dateLabel(lastManual)}</span><span>Automatic (Stockholm): {dateLabel(lastAuto)}</span></div>
      <div className="pager"><span>{filtered.length ? `${(safePage - 1) * 50 + 1}–${Math.min(safePage * 50, filtered.length)}` : '0'} / {filtered.length}</span><button disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Previous page">‹</button><span>{safePage} / {pageCount}</span><button disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)} aria-label="Next page">›</button></div>
    </section>
    <section className="grid-wrap"><table className="price-grid"><thead><tr>
      <th rowSpan={2} className="check"><input aria-label="Select current page" type="checkbox" checked={allPageSelected} onChange={togglePage}/></th><th rowSpan={2} className="product-head">No. / SKU / Product</th>
      {COUNTRIES.map((country) => <th key={country} colSpan={3} className="country-head">{country} <small>({currency[country]})</small></th>)}<th rowSpan={2} className="action-head">Actions</th>
    </tr><tr>{COUNTRIES.flatMap((country) => [<th key={`${country}-own`}>MiStore Price</th>, <th key={`${country}-market`}>Lowest Price<br/>in Market</th>, <th key={`${country}-expected`}>Expected Price</th>])}</tr></thead><tbody>
      {loading ? <tr><td colSpan={15} className="state-row">Loading products…</td></tr> : !pageRows.length ? <tr><td colSpan={15} className="state-row">No products match this filter.</td></tr> : pageRows.map((group) => {
        const product = group.primary; const groupIndex = filtered.findIndex((item) => item.key === group.key); const checked = group.members.every((member) => selected.has(member.id));
        return <tr key={group.key}><td className="check"><input type="checkbox" checked={checked} readOnly onClick={(event) => toggleGroup(group, groupIndex, event.shiftKey)} aria-label={`Select product ${numbers.get(group.key)}`}/></td>
          <td className="product-cell"><strong><span className="row-number">{numbers.get(group.key)}.</span> {product.sku || group.variants[0]?.sku || '—'}</strong><span title={product.markets.SE.mistoreName || product.productName}>{product.markets.SE.mistoreName || product.productName}</span>
            {group.variants.length > 1 ? <span className="variant-trigger" tabIndex={0}>Variants ({group.variants.length})<span className="variant-popover">{group.variants.map((variant, index) => <span key={`${variant.sku}|${variant.ean}|${index}`}>{variant.title || `Variant ${index + 1}`} · SKU {variant.sku || '—'} · EAN {variant.ean || '—'}</span>)}</span></span> : <small>{product.ean || group.variants[0]?.ean || 'No EAN'}</small>}
          </td>
          {COUNTRIES.flatMap((country) => {
            const market = product.markets[country]; const ownDiff = rangeDifference(group, country, market.lowPriceMinor); const expectedDiff = difference(market.expectedPriceMinor, market.lowPriceMinor); const key = `${product.id}:${country}`;
            const tooltip = `Manual: ${dateLabel(market.manualRefreshedAt)} | Automatic: ${dateLabel(market.autoRefreshedAt)}`;
            return [<td key={`${country}-own`} className="price-cell" title={tooltip}><a className="price-link" href={market.mistoreUrl || undefined} target="_blank" rel="noreferrer" title={priceRange(group, country)}>{priceRange(group, country)}</a><small className={ownDiff ? ownDiff.percentage > 0 ? 'bad' : 'good' : 'neutral'}>{ownDiff?.label ?? '—'}</small></td>,
              <td key={`${country}-market`} className="price-cell" title={tooltip}>{market.lowPriceMinor != null && market.marketProductUrl
                ? <a className="price-link" href={market.marketProductUrl} target="_blank" rel="noreferrer">{money(market.lowPriceMinor, country)}</a>
                : <span className="price-link">—</span>}<small className="merchant" title={market.lowMerchant ?? ''}>{market.lowMerchant || 'Not matched'}</small></td>,
              <td key={`${country}-expected`} className="price-cell expected-cell"><input aria-label={`${country} Expected Price for product ${numbers.get(group.key)}`} value={key in expectedDraft ? expectedDraft[key] : market.expectedPriceMinor == null ? '' : String(market.expectedPriceMinor / 100)} onChange={(event) => setExpectedDraft((draft) => ({ ...draft, [key]: event.target.value }))} onBlur={() => void saveExpected(product, country)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} placeholder="—"/><small className={expectedDiff ? expectedDiff.percentage > 0 ? 'bad' : 'good' : 'neutral'}>{expectedDiff?.label ?? '—'}</small></td>];
          })}<td className="action-cell"><button className="match-button" onClick={() => openMatch(product)}>Match / Edit</button></td>
        </tr>;
      })}
    </tbody></table></section>
    {notice && <div className="toast"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notification">×</button></div>}
    {collectionsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCollectionsOpen(false); }}><section className="modal collections-modal"><header><div><h2>Selected MiStore collections</h2><p>Add only the collections your team uses. Product membership comes from MiStore.se.</p></div><button className="close" onClick={() => setCollectionsOpen(false)}>Close</button></header>
      <div className="manual-search"><input value={collectionInput} onChange={(event) => setCollectionInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveCollection(); }} placeholder="MiStore.se collection URL or handle"/><button className="button primary" onClick={() => void saveCollection()} disabled={collectionSaving}>{collectionSaving ? 'Reading…' : 'Add / refresh'}</button></div>
      <div className="collection-list">{collections.length ? collections.map((collection) => <div key={collection.handle} className="collection-item"><div><strong>{collection.title}</strong><small>{collection.productHandles.length} products · Updated {dateLabel(collection.updatedAt)} Stockholm</small></div><div><button className="button" onClick={() => void saveCollection(collection.handle)} disabled={collectionSaving}>Refresh</button><button className="remove-match" onClick={() => void removeCollection(collection.handle)}>Remove</button></div></div>) : <p className="candidate-empty">No collections selected yet.</p>}</div>
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
