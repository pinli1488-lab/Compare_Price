const base = process.env.PRICE_DESK_URL?.replace(/\/$/, '');
if (!base) throw new Error('PRICE_DESK_URL is required');
const countries = ['SE', 'DK', 'FI', 'NO'];
async function request(path, body) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(base + path, { ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
      const result = await response.json();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
      return result;
    } catch (error) { last = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1))); }
  }
  throw last;
}
const initial = await request('/api/products?fresh=1');
const products = initial.products;
if (!Array.isArray(products)) throw new Error('Invalid product list');
console.log(`START full refresh: ${products.length} product records, four countries, batches of eight, 12h policy retained.`);
try { const costs = await request('/api/lark/sync', {}); console.log('Lark costs:', JSON.stringify({synced:costs.synced,error:costs.error})); }
catch(error) { console.warn('Cost sync failed; price refresh continues:', String(error)); }
const stats = { products: products.length, processed: 0, updatedCountries: 0, skippedCountries: 0, countryErrors: [], publishedRows: 0, marketRows: 0, publishErrors: [] };
for (let offset = 0; offset < products.length; offset += 8) {
  const batch = products.slice(offset, offset + 8);
  // At most two products are refreshed concurrently; publish only after their batch settles.
  for (let index = 0; index < batch.length; index += 2) await Promise.all(batch.slice(index,index + 2).map(async product => {
    const results = await Promise.allSettled(countries.map(country => request('/api/refresh', {ids:[product.id],country,source:'manual'})));
    results.forEach((result,index) => {
      if (result.status === 'rejected') stats.countryErrors.push({sku:product.sku,id:product.id,country:countries[index],error:String(result.reason)});
      else {
        stats.updatedCountries += result.value.updated?.length ?? 0;
        stats.skippedCountries += result.value.skipped?.length ?? 0;
        for(const error of result.value.errors ?? []) stats.countryErrors.push({sku:product.sku,...error});
      }
    });
    stats.processed++;
  }));
  try {
    let result;
    for(let pass=0;pass<20;pass++) {
      result = await request('/api/lark/publish', {ids:batch.map(product=>product.id)});
      if(result.marketError) throw new Error(result.marketError);
      if(!result.fieldsRemaining) break;
    }
    if(result.fieldsRemaining) throw new Error('Lark field setup did not finish');
    stats.publishedRows += result.published ?? 0;
    stats.marketRows += result.marketPublished ?? 0;
  } catch(error) { stats.publishErrors.push({ids:batch.map(p=>p.id),error:String(error)}); }
  console.log(`PROGRESS ${stats.processed}/${stats.products}: updated ${stats.updatedCountries}, reused ${stats.skippedCountries}, country errors ${stats.countryErrors.length}, publish errors ${stats.publishErrors.length}, market SKU writes ${stats.marketRows}`);
}
// Retry only failed write batches; do not refresh their country prices again.
const failed = stats.publishErrors; stats.publishErrors = [];
for(const batch of failed) {
  try { const result=await request('/api/lark/publish',{ids:batch.ids}); if(result.marketError||result.fieldsRemaining)throw Error(result.marketError||'Fields incomplete'); stats.publishedRows+=result.published??0;stats.marketRows+=result.marketPublished??0; }
  catch(error){stats.publishErrors.push({...batch,error:String(error)});}
}
const audit = await request('/api/lark/market?audit=1');
// Concurrent changes may have arrived while records were read: repair implicated SKUs once, from current data.
if(audit.quoteIntegrityErrors?.length) {
  const skus=new Set(audit.quoteIntegrityErrors.map(error=>error.split(':')[0]));
  const ids=products.filter(p=>skus.has(p.sku)||Object.values(p.variants??{}).flat().some(v=>skus.has(v.sku))).map(p=>p.id);
  for(let offset=0;offset<ids.length;offset+=8)await request('/api/lark/market',{ids:ids.slice(offset,offset+8)});
}
const verified = audit.quoteIntegrityErrors?.length ? await request('/api/lark/market?audit=1') : audit;
console.log('SUMMARY',JSON.stringify(stats));
console.log('LARK AUDIT',JSON.stringify({rows:verified.totalRows,duplicateSkus:verified.duplicateSkus,quoteIntegrityErrors:verified.quoteIntegrityErrors}));
if(stats.publishErrors.length || verified.quoteIntegrityErrors?.length || verified.duplicateSkus?.length) throw Error('Lark synchronization requires attention; see summary.');
console.log('DONE full product refresh and Lark writeback. Unavailable matches/offers are listed in countryErrors.');
