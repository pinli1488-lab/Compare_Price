import { ensureSchema, getD1 } from '@/db/store';
import { auditMarketTable, resolveMarketTarget } from '@/lib/lark-market';
import { publishMarketPriceDesk } from '@/lib/lark-publish';
export const runtime = 'edge';
export async function GET(request: Request) {
  await ensureSchema();
  if (new URL(request.url).searchParams.get('audit') === '1') {
    try { return Response.json(await auditMarketTable()); }
    catch(error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 }); }
  }
  const target = await getD1().prepare('SELECT base_token,table_id FROM market_lark_target WHERE id=1').first();
  const status = await getD1().prepare("SELECT last_synced_at,last_error FROM integration_status WHERE integration='lark_market'").first();
  return Response.json({ connected: Boolean(target), tableId: target?.table_id ?? null, lastSyncedAt: status?.last_synced_at ?? null, error: status?.last_error ?? null });
}
export async function POST(request: Request) {
  try {
    await ensureSchema();
    const body = await request.json().catch(() => ({})) as { ids?: unknown };
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.length > 8 || body.ids.some(id => typeof id !== 'string')) return Response.json({ error: 'Provide at most eight product IDs.' }, { status: 400 });
      return Response.json(await publishMarketPriceDesk(body.ids));
    }
    return Response.json({ connected: true, target: await resolveMarketTarget() });
  }
  catch(error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 }); }
}
