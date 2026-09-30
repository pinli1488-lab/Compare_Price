import { ensureSchema } from '@/db/store';
import { publishPriceDesk } from '@/lib/lark-publish';

export const runtime = 'edge';

export async function POST(request: Request) {
  await ensureSchema();
  const body = await request.json().catch(() => ({})) as { ids?: unknown };
  if (!Array.isArray(body.ids) || body.ids.length > 8 || body.ids.some((id) => typeof id !== 'string')) {
    return Response.json({ error: 'Provide at most eight product IDs.' }, { status: 400 });
  }
  try {
    return Response.json(await publishPriceDesk(body.ids));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
