import { ensureSchema, getD1 } from '@/db/store';

export const runtime = 'edge';

type ShopifyProduct = { handle?: string };
const storefrontHeaders = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36',
  'accept-language': 'en,sv;q=0.8', accept: 'application/json', referer: 'https://mistore.se/',
};

function collectionHandle(input: string) {
  const value = input.trim();
  try {
    const url = new URL(value);
    if (url.hostname !== 'mistore.se' && url.hostname !== 'www.mistore.se') return null;
    const handle = url.pathname.match(/^\/collections\/([a-z0-9-]+)\/?$/i)?.[1];
    return handle?.toLowerCase() ?? null;
  } catch { return /^[a-z0-9-]+$/i.test(value) ? value.toLowerCase() : null; }
}

async function fetchCollection(handle: string) {
  const metaResponse = await fetch(`https://mistore.se/collections/${handle}.json`, { headers: storefrontHeaders });
  if (!metaResponse.ok) throw new Error(`MiStore collection returned ${metaResponse.status}`);
  const meta = await metaResponse.json() as { collection?: { title?: string; handle?: string } };
  if (!meta.collection?.handle) throw new Error('Collection was not found on MiStore');
  const handles = new Set<string>(); let complete = false;
  for (let page = 1; page <= 8; page += 1) {
    const response = await fetch(`https://mistore.se/collections/${handle}/products.json?limit=250&page=${page}`, { headers: storefrontHeaders });
    if (!response.ok) throw new Error(`MiStore collection products returned ${response.status}`);
    const body = await response.json() as { products?: ShopifyProduct[] };
    const products = body.products ?? [];
    for (const product of products) if (product.handle) handles.add(product.handle);
    if (products.length < 250) { complete = true; break; }
  }
  if (!complete) throw new Error('This collection is larger than 2,000 products. Add a narrower collection.');
  return { handle, title: meta.collection.title || handle, productHandles: [...handles], updatedAt: new Date().toISOString() };
}

export async function GET() {
  await ensureSchema();
  const result = await getD1().prepare('SELECT handle,title,product_handles_json,updated_at FROM selected_collections ORDER BY title').all();
  return Response.json({ collections: result.results.map((row) => ({
    handle: String(row.handle), title: String(row.title), productHandles: JSON.parse(String(row.product_handles_json)) as string[], updatedAt: String(row.updated_at),
  })) });
}

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json() as { url?: string; handle?: string };
  const handle = collectionHandle(body.url || body.handle || '');
  if (!handle) return Response.json({ error: 'Enter a MiStore.se collection URL or handle' }, { status: 400 });
  try {
    const collection = await fetchCollection(handle);
    await getD1().prepare(`INSERT INTO selected_collections(handle,title,product_handles_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(handle) DO UPDATE SET title=excluded.title,product_handles_json=excluded.product_handles_json,updated_at=excluded.updated_at`)
      .bind(collection.handle, collection.title, JSON.stringify(collection.productHandles), collection.updatedAt).run();
    return Response.json({ collection });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Collection lookup failed' }, { status: 422 }); }
}

export async function DELETE(request: Request) {
  await ensureSchema();
  const body = await request.json() as { handle?: string };
  const handle = collectionHandle(body.handle || '');
  if (!handle) return Response.json({ error: 'Invalid collection handle' }, { status: 400 });
  await getD1().prepare('DELETE FROM selected_collections WHERE handle=?').bind(handle).run();
  return Response.json({ removed: true });
}
