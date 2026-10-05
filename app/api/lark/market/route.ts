import { ensureSchema, getD1 } from '@/db/store';
import { resolveMarketTarget } from '@/lib/lark-market';
export const runtime = 'edge';
export async function GET() {
  await ensureSchema();
  const target = await getD1().prepare('SELECT base_token,table_id FROM market_lark_target WHERE id=1').first();
  const status = await getD1().prepare("SELECT last_synced_at,last_error FROM integration_status WHERE integration='lark_market'").first();
  return Response.json({ connected: Boolean(target), tableId: target?.table_id ?? null, lastSyncedAt: status?.last_synced_at ?? null, error: status?.last_error ?? null });
}
export async function POST() {
  try { await ensureSchema(); return Response.json({ connected: true, target: await resolveMarketTarget() }); }
  catch(error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 }); }
}
