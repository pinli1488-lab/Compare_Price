import { searchProducts } from '@/lib/prisjakt';

export const runtime = 'edge';

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q') ?? '';
  if (!query.trim()) return Response.json({ candidates: [] });
  try {
    return Response.json({ candidates: await searchProducts(query) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Prisjakt 搜索失败' }, { status: 502 });
  }
}
