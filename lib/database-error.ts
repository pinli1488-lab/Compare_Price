export function databaseErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  if (/free tier daily|daily.*limit/i.test(message)) {
    const now = new Date();
    const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return Response.json({
      error: 'Cloudflare daily database quota reached. Your saved products are still stored. Database access resumes at 08:00 Beijing time, or after upgrading the Cloudflare plan.',
      code: 'D1_DAILY_QUOTA', retryable: false, resetAt: resetAt.toISOString(),
    }, { status: 503, headers: { 'Retry-After': String(Math.ceil((resetAt.getTime() - now.getTime()) / 1000)), 'Cache-Control': 'no-store' } });
  }
  console.error('Database request failed:', error);
  return Response.json({ error: 'Database temporarily unavailable. Your saved data has not been cleared. Please retry.', retryable: true }, { status: 503 });
}
