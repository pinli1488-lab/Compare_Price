import { searchMiStore } from '@/lib/mistore';
import { searchProducts } from '@/lib/prisjakt';
import { isCountryCode } from '@/lib/countries';

export const runtime = 'edge';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get('q') ?? '';
  const country = params.get('country') ?? 'SE';
  const source = params.get('source') ?? 'both';
  if (!query.trim()) return Response.json({ mistoreCandidates: [], marketCandidates: [] });
  if (!isCountryCode(country)) return Response.json({ error: 'Invalid country' }, { status: 400 });
  try {
    const [mistoreCandidates, marketCandidates] = await Promise.all([
      source === 'market' ? Promise.resolve([]) : searchMiStore(query, country),
      source === 'mistore' ? Promise.resolve([]) : searchProducts(query, country),
    ]);
    return Response.json({ mistoreCandidates, marketCandidates });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '搜索失败' }, { status: 502 });
  }
}
