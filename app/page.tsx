'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import readXlsxFile from 'read-excel-file';
import writeXlsxFile from 'write-excel-file';

type Product = {
  id: string; sku: string; productName: string; ean: string; ownPriceOre: number; currency: string;
  matchedProductId: string | null; matchedProductName: string | null; matchedProductUrl: string | null;
  matchConfidence: number | null; matchStatus: 'pending' | 'auto' | 'confirmed' | 'not_found';
  lowPriceOre: number | null; lowMerchant: string | null; lowUrl: string | null;
  highPriceOre: number | null; highMerchant: string | null; highUrl: string | null;
  updatedAt: string | null; createdAt: string;
};

type Candidate = { id: string; name: string; url: string; previewPrice: number | null; currency: string; confidence: number };
type Matrix = Array<Array<string | number | boolean | Date | null>>;
type ColumnMap = { sku: number; name: number; ean: number; price: number };
type Filter = 'all' | 'above' | 'below' | 'pending';

const headerAliases = {
  sku: ['sku', 'artikelnummer', 'item number', 'product id', '产品编号'],
  name: ['product name', 'title', 'produktnamn', 'product', 'name', '产品名称', '商品名称'],
  ean: ['ean', 'gtin', 'barcode', '条码'],
  price: ['our price', 'own price', 'sale price', 'price', 'pris', '我们的价格', '我方价格', '售价'],
};

function normalizeHeader(value: unknown) { return String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' '); }
function guessColumn(headers: unknown[], aliases: string[], fallback = -1) {
  const normalized = headers.map(normalizeHeader);
  const exact = normalized.findIndex((header) => aliases.includes(header));
  if (exact >= 0) return exact;
  const partial = normalized.findIndex((header) => aliases.some((alias) => header.includes(alias)));
  return partial >= 0 ? partial : fallback;
}
function parsePrice(value: unknown) {
  if (typeof value === 'number') return value;
  let text = String(value ?? '').trim().replace(/\s/g, '').replace(/[^\d,.-]/g, '');
  if (text.includes(',') && text.includes('.')) text = text.lastIndexOf(',') > text.lastIndexOf('.') ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  else if (text.includes(',')) text = /,\d{1,2}$/.test(text) ? text.replace(',', '.') : text.replace(/,/g, '');
  return Number(text);
}
function parseCsv(text: string): Matrix {
  const rows: Matrix = []; let row: Matrix[number] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if ((char === ',' || char === ';') && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); if (row.some((value) => String(value).trim())) rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  row.push(cell); if (row.some((value) => String(value).trim())) rows.push(row);
  return rows;
}
function csvEscape(value: unknown) { const text = String(value ?? ''); return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
function formatMoney(ore: number | null, currency = 'SEK') {
  if (ore == null) return '—';
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency, maximumFractionDigits: ore % 100 ? 2 : 0 }).format(ore / 100);
}
function percentDifference(own: number, market: number | null) { return market ? ((own - market) / market) * 100 : null; }
function formatDifference(own: number, market: number | null) { if (market == null) return '—'; const value = own - market; return `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatMoney(Math.abs(value))}`; }
function localDate(iso: string | null) { return iso ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '尚未更新'; }

export default function Home() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [matrix, setMatrix] = useState<Matrix>([]);
  const [columnMap, setColumnMap] = useState<ColumnMap>({ sku: -1, name: -1, ean: -1, price: -1 });
  const [pasteText, setPasteText] = useState('');
  const [manual, setManual] = useState({ sku: '', name: '', ean: '', price: '' });
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [matchProduct, setMatchProduct] = useState<Product | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadProducts = useCallback(async () => {
    const response = await fetch('/api/products', { cache: 'no-store' });
    const data = await response.json() as { products?: Product[]; error?: string };
    if (!response.ok) throw new Error(data.error || '读取产品失败');
    setProducts(data.products ?? []);
  }, []);

  useEffect(() => { queueMicrotask(() => loadProducts().catch((error) => setNotice(error.message)).finally(() => setLoading(false))); }, [loadProducts]);
  useEffect(() => { const timer = window.setInterval(() => setClockTick((value) => value + 1), 60_000); return () => window.clearInterval(timer); }, []);

  const counts = useMemo(() => ({
    all: products.length,
    matched: products.filter((p) => p.lowPriceOre != null).length,
    above: products.filter((p) => p.lowPriceOre != null && p.ownPriceOre > p.lowPriceOre).length,
    below: products.filter((p) => p.lowPriceOre != null && p.ownPriceOre <= p.lowPriceOre).length,
    pending: products.filter((p) => p.matchStatus === 'pending' || p.matchStatus === 'not_found').length,
  }), [products]);

  const visibleProducts = useMemo(() => products.filter((product) => {
    const search = query.trim().toLowerCase();
    const matchesSearch = !search || `${product.sku} ${product.ean} ${product.productName} ${product.matchedProductName ?? ''}`.toLowerCase().includes(search);
    if (!matchesSearch) return false;
    if (filter === 'above') return product.lowPriceOre != null && product.ownPriceOre > product.lowPriceOre;
    if (filter === 'below') return product.lowPriceOre != null && product.ownPriceOre <= product.lowPriceOre;
    if (filter === 'pending') return product.matchStatus === 'pending' || product.matchStatus === 'not_found';
    return true;
  }), [products, query, filter]);

  function setParsedMatrix(rows: Matrix) {
    setMatrix(rows);
    const headers = rows[0] ?? [];
    setColumnMap({ sku: guessColumn(headers, headerAliases.sku), name: guessColumn(headers, headerAliases.name, 0), ean: guessColumn(headers, headerAliases.ean), price: guessColumn(headers, headerAliases.price, headers.length > 1 ? 1 : -1) });
  }

  async function chooseFile(file?: File) {
    if (!file) return;
    try {
      const rows = file.name.toLowerCase().endsWith('.csv') ? parseCsv(await file.text()) : await readXlsxFile(file) as Matrix;
      setParsedMatrix(rows);
      setNotice(`已读取 ${Math.max(0, rows.length - 1)} 行，请确认字段映射`);
    } catch { setNotice('文件读取失败，请使用有效的 .xlsx 或 .csv 文件'); }
  }

  function parsePaste() {
    const rows = parseCsv(pasteText.replace(/\t/g, ','));
    if (!rows.length) return setNotice('请先粘贴数据');
    setParsedMatrix(rows);
  }

  async function submitProducts(items: Array<{ sku: string; productName: string; ean: string; ownPrice: number }>) {
    const valid = items.filter((item) => item.productName && Number.isFinite(item.ownPrice));
    if (!valid.length) return setNotice('没有找到有效的产品名称和价格');
    const response = await fetch('/api/products', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ products: valid }) });
    const data = await response.json() as { imported?: number; error?: string };
    if (!response.ok) return setNotice(data.error || '导入失败');
    await loadProducts(); setImportOpen(false); setMatrix([]); setPasteText(''); setManual({ sku: '', name: '', ean: '', price: '' });
    setNotice(`成功导入 ${data.imported} 个产品`);
  }

  function importMappedRows() {
    if (columnMap.name < 0 || columnMap.price < 0) return setNotice('必须选择产品名称和我们的价格列');
    submitProducts(matrix.slice(1).map((row) => ({
      sku: columnMap.sku >= 0 ? String(row[columnMap.sku] ?? '') : '', productName: String(row[columnMap.name] ?? '').trim(),
      ean: columnMap.ean >= 0 ? String(row[columnMap.ean] ?? '') : '', ownPrice: parsePrice(row[columnMap.price]),
    })));
  }

  const refreshIds = useCallback(async (ids: string[], quiet = false) => {
    if (!ids.length || refreshing) return;
    setRefreshing(true); setProgress({ done: 0, total: ids.length });
    let errorCount = 0;
    for (let index = 0; index < ids.length; index += 8) {
      const chunk = ids.slice(index, index + 8);
      try {
        const response = await fetch('/api/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: chunk }) });
        const data = await response.json() as { errors?: unknown[] };
        if (!response.ok) errorCount += chunk.length; else errorCount += data.errors?.length ?? 0;
      } catch { errorCount += chunk.length; }
      setProgress({ done: Math.min(index + chunk.length, ids.length), total: ids.length });
    }
    await loadProducts(); setRefreshing(false);
    if (!quiet) setNotice(errorCount ? `刷新完成，${errorCount} 个产品需要人工确认或稍后重试` : `已更新 ${ids.length} 个产品`);
  }, [loadProducts, refreshing]);

  useEffect(() => {
    if (loading || !products.length || refreshing) return;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const stale = products.filter((product) => !product.updatedAt || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(product.updatedAt)) < today);
    const key = `pricedesk-refresh-${today}`;
    if (stale.length && !sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      window.setTimeout(() => refreshIds(stale.map((p) => p.id), true), 0);
    }
  }, [clockTick, loading, products, refreshIds, refreshing]);

  async function removeSelected() {
    if (!selected.size || !window.confirm(`确认删除选中的 ${selected.size} 个产品？`)) return;
    await fetch('/api/products', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...selected] }) });
    setSelected(new Set()); await loadProducts(); setNotice('已删除所选产品');
  }

  async function openMatch(product: Product) {
    setMatchProduct(product); setCandidates([]); setCandidateLoading(true);
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(product.productName)}`);
      const data = await response.json() as { candidates?: Candidate[]; error?: string };
      if (!response.ok) throw new Error(data.error || '搜索失败'); setCandidates(data.candidates ?? []);
    } catch (error) { setNotice(error instanceof Error ? error.message : '搜索失败'); }
    finally { setCandidateLoading(false); }
  }

  async function chooseCandidate(candidate: Candidate) {
    if (!matchProduct) return;
    const response = await fetch('/api/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: matchProduct.id, productId: candidate.id, productName: candidate.name, productUrl: candidate.url }) });
    const data = await response.json() as { error?: string };
    if (!response.ok) return setNotice(data.error || '保存匹配失败');
    setMatchProduct(null); await loadProducts(); setNotice('商品匹配已确认');
  }

  function exportRows() {
    return visibleProducts.map((p) => [p.sku, p.productName, p.ean, p.ownPriceOre / 100, p.matchedProductName ?? '', p.lowPriceOre == null ? '' : p.lowPriceOre / 100, p.lowMerchant ?? '', p.highPriceOre == null ? '' : p.highPriceOre / 100, p.highMerchant ?? '', p.lowPriceOre == null ? '' : (p.ownPriceOre - p.lowPriceOre) / 100, p.highPriceOre == null ? '' : (p.ownPriceOre - p.highPriceOre) / 100, p.matchedProductUrl ?? '', p.matchStatus, p.updatedAt ?? '']);
  }
  const exportHeaders = ['SKU', '产品名称', 'EAN', '我们的价格 (SEK)', 'Prisjakt 匹配商品', '市场最低价 (SEK)', '最低价商家', '市场最高价 (SEK)', '最高价商家', '与最低价差额 (SEK)', '与最高价差额 (SEK)', '商品链接', '匹配状态', '更新时间'];
  function exportCsv() {
    const csv = [exportHeaders, ...exportRows()].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })); link.download = `PriceDesk_${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(link.href); setExportOpen(false);
  }
  async function exportExcel() {
    const rows = [exportHeaders, ...exportRows()].map((row, rowIndex) => row.map((value) => ({ value, type: typeof value === 'number' ? Number : String, fontWeight: rowIndex === 0 ? 'bold' as const : undefined, backgroundColor: rowIndex === 0 ? '#262626' : undefined, color: rowIndex === 0 ? '#FFFFFF' : '#171717' })));
    await writeXlsxFile(rows, { fileName: `PriceDesk_${new Date().toISOString().slice(0, 10)}.xlsx`, stickyRowsCount: 1 }); setExportOpen(false);
  }

  const allVisibleSelected = visibleProducts.length > 0 && visibleProducts.every((p) => selected.has(p.id));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">P</span><div><strong>PriceDesk</strong><small>Prisjakt 批量比价</small></div></div>
        <div className="topbar-actions"><span className="sync-state"><i /> 北京时间每日自动更新</span><div className="dropdown-wrap"><button className="button secondary" onClick={() => setExportOpen((v) => !v)}>导出结果⌄</button>{exportOpen && <div className="dropdown"><button onClick={exportExcel}>导出 Excel (.xlsx)</button><button onClick={exportCsv}>导出 CSV</button></div>}</div><button className="button primary" onClick={() => setImportOpen(true)}>＋ 导入产品</button></div>
      </header>

      <section className="workspace">
        <div className="heading-row"><div><p className="eyebrow">共享工作区</p><h1>自有价格与市场价格，一张表看清</h1><p className="subtitle">批量导入产品，自动匹配 Prisjakt 报价并排除 Mistore / Mistore.se。</p></div><button className="button refresh" disabled={refreshing || !products.length} onClick={() => refreshIds((selected.size ? products.filter((p) => selected.has(p.id)) : visibleProducts).map((p) => p.id))}>{refreshing ? `更新中 ${progress.done}/${progress.total}` : '↻ 刷新市场价'}</button></div>

        <div className="metrics" aria-label="价格概览"><article><span>产品总数</span><strong>{counts.all}</strong><small>共享产品库</small></article><article><span>已取得市场价</span><strong>{counts.matched}</strong><small>{counts.all ? `${Math.round(counts.matched / counts.all * 100)}% 已完成` : '等待导入'}</small></article><article><span>我方高于最低价</span><strong>{counts.above}</strong><small>需要关注</small></article><article><span>待人工确认</span><strong>{counts.pending}</strong><small>点击行末进行匹配</small></article></div>

        <section className="data-panel">
          <div className="toolbar"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索产品" placeholder="搜索 SKU、EAN 或产品名称" /></label><div className="filter-group"><button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>全部 {counts.all}</button><button className={`chip ${filter === 'above' ? 'active' : ''}`} onClick={() => setFilter('above')}>高于市场 {counts.above}</button><button className={`chip ${filter === 'below' ? 'active' : ''}`} onClick={() => setFilter('below')}>不高于市场 {counts.below}</button><button className={`chip ${filter === 'pending' ? 'active' : ''}`} onClick={() => setFilter('pending')}>待确认 {counts.pending}</button></div>{selected.size > 0 && <button className="delete-button" onClick={removeSelected}>删除 {selected.size} 项</button>}</div>
          <div className="table-wrap"><table><thead><tr><th className="check"><input type="checkbox" checked={allVisibleSelected} onChange={() => setSelected(allVisibleSelected ? new Set() : new Set(visibleProducts.map((p) => p.id)))} aria-label="选择全部可见产品" /></th><th>SKU / 产品</th><th>我们的价格</th><th>市场最低价</th><th>市场最高价</th><th>与最低价差额</th><th>与最高价差额</th><th>匹配 / 更新</th><th /></tr></thead><tbody>
            {loading ? <tr><td colSpan={9} className="state-row">正在读取共享产品库…</td></tr> : visibleProducts.length === 0 ? <tr><td colSpan={9} className="state-row"><strong>{products.length ? '没有符合当前条件的产品' : '还没有产品'}</strong><small>{products.length ? '更换筛选条件或搜索词' : '点击“导入产品”添加 Excel、CSV 或手动输入'}</small></td></tr> : visibleProducts.map((p) => {
              const diffLow = percentDifference(p.ownPriceOre, p.lowPriceOre); const diffHigh = percentDifference(p.ownPriceOre, p.highPriceOre);
              return <tr key={p.id}><td className="check"><input type="checkbox" checked={selected.has(p.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; })} aria-label={`选择 ${p.productName}`} /></td><td className="product-cell"><strong>{p.productName}</strong><small>{[p.sku, p.ean].filter(Boolean).join(' · ') || '无 SKU / EAN'}</small></td><td className="number strong-number">{formatMoney(p.ownPriceOre, p.currency)}</td><td className="number"><a href={p.lowUrl ?? undefined} target="_blank" rel="noreferrer"><strong>{formatMoney(p.lowPriceOre, p.currency)}</strong><small>{p.lowMerchant ?? '等待刷新'}</small></a></td><td className="number"><a href={p.highUrl ?? undefined} target="_blank" rel="noreferrer"><strong>{formatMoney(p.highPriceOre, p.currency)}</strong><small>{p.highMerchant ?? '等待刷新'}</small></a></td><td className={`number difference ${diffLow != null && diffLow <= 0 ? 'positive' : ''}`}><strong>{formatDifference(p.ownPriceOre, p.lowPriceOre)}</strong><small>{diffLow == null ? '' : `${diffLow > 0 ? '+' : ''}${diffLow.toFixed(1)}%`}</small></td><td className={`number difference ${diffHigh != null && diffHigh <= 0 ? 'positive' : ''}`}><strong>{formatDifference(p.ownPriceOre, p.highPriceOre)}</strong><small>{diffHigh == null ? '' : `${diffHigh > 0 ? '+' : ''}${diffHigh.toFixed(1)}%`}</small></td><td className="match-cell"><a href={p.matchedProductUrl ?? undefined} target="_blank" rel="noreferrer"><strong>{p.matchedProductName ?? (p.matchStatus === 'not_found' ? '未找到商品' : '等待自动匹配')}</strong></a><small>{p.matchConfidence != null ? `${p.matchConfidence}% 匹配 · ` : ''}{localDate(p.updatedAt)}</small></td><td><button className="match-button" onClick={() => openMatch(p)}>{p.matchStatus === 'confirmed' ? '更改' : '确认'}</button></td></tr>;
            })}
          </tbody></table></div>
          <div className="table-footer"><span>显示 {visibleProducts.length} / {products.length} 个产品</span><button className="text-button" onClick={() => setImportOpen(true)}>＋ 添加更多产品</button></div>
        </section>
      </section>

      {notice && <div className="toast" role="status"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}

      {importOpen && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setImportOpen(false)}><section className="modal import-modal"><header><div><p className="eyebrow">批量导入</p><h2>添加产品与我们的价格</h2></div><button className="close" onClick={() => setImportOpen(false)}>×</button></header><div className="import-grid"><div className="import-method"><h3>上传 Excel / CSV</h3><p>第一行应为字段表头，支持最多 1,200 行。</p><input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={(event) => chooseFile(event.target.files?.[0])} /><button className="upload-area" onClick={() => fileRef.current?.click()}><span>⇧</span><strong>选择 .xlsx 或 .csv 文件</strong><small>系统会自动识别 SKU、名称、EAN 与价格列</small></button></div><div className="import-method"><h3>粘贴表格</h3><p>可直接从 Excel 或 Numbers 复制后粘贴。</p><textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder={'SKU\t产品名称\tEAN\t我们的价格\nBHR6068EU\tXiaomi Robot Vacuum S10\t...\t2899'} /><button className="button secondary full" onClick={parsePaste}>读取粘贴内容</button></div><div className="import-method"><h3>手动添加一个产品</h3><p>适合临时查询单个商品。</p><div className="manual-fields"><input placeholder="SKU（选填）" value={manual.sku} onChange={(e) => setManual({ ...manual, sku: e.target.value })} /><input placeholder="产品名称 *" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} /><input placeholder="EAN（选填）" value={manual.ean} onChange={(e) => setManual({ ...manual, ean: e.target.value })} /><input placeholder="我们的价格 (SEK) *" value={manual.price} onChange={(e) => setManual({ ...manual, price: e.target.value })} /></div><button className="button secondary full" onClick={() => submitProducts([{ sku: manual.sku, productName: manual.name.trim(), ean: manual.ean, ownPrice: parsePrice(manual.price) }])}>添加产品</button></div></div>
        {matrix.length > 0 && <div className="mapping"><div className="mapping-head"><div><h3>确认字段映射</h3><p>已读取 {Math.max(0, matrix.length - 1)} 行。产品名称和价格为必选字段。</p></div><button className="button primary" onClick={importMappedRows}>导入 {Math.max(0, matrix.length - 1)} 行</button></div><div className="mapping-fields">{([['sku', 'SKU'], ['name', '产品名称 *'], ['ean', 'EAN'], ['price', '我们的价格 *']] as const).map(([key, label]) => <label key={key}><span>{label}</span><select value={columnMap[key]} onChange={(e) => setColumnMap({ ...columnMap, [key]: Number(e.target.value) })}><option value={-1}>不导入</option>{(matrix[0] ?? []).map((header, index) => <option key={index} value={index}>{String(header || `第 ${index + 1} 列`)}</option>)}</select></label>)}</div><div className="preview-table"><table><thead><tr>{(matrix[0] ?? []).map((header, index) => <th key={index}>{String(header)}</th>)}</tr></thead><tbody>{matrix.slice(1, 4).map((row, rowIndex) => <tr key={rowIndex}>{(matrix[0] ?? []).map((_, index) => <td key={index}>{String(row[index] ?? '')}</td>)}</tr>)}</tbody></table></div></div>}
      </section></div>}

      {matchProduct && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setMatchProduct(null)}><section className="modal match-modal"><header><div><p className="eyebrow">人工确认</p><h2>选择正确的 Prisjakt 商品</h2><p className="modal-subtitle">{matchProduct.productName}</p></div><button className="close" onClick={() => setMatchProduct(null)}>×</button></header><div className="candidate-list">{candidateLoading ? <div className="state-row">正在搜索 Prisjakt…</div> : candidates.length === 0 ? <div className="state-row">没有找到候选商品</div> : candidates.map((candidate) => <button key={candidate.id} className="candidate" onClick={() => chooseCandidate(candidate)}><div><strong>{candidate.name}</strong><small>Prisjakt ID {candidate.id} · 预览价 {candidate.previewPrice == null ? '—' : `${candidate.previewPrice} ${candidate.currency}`}</small></div><span>{candidate.confidence}% 匹配</span></button>)}</div></section></div>}
    </main>
  );
}
