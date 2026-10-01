export const REFRESH_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export function recentSuccessfulRefresh(row: Record<string, unknown> | null, now = Date.now()) {
  if (!row || row.mistore_price_minor == null || row.low_price_minor == null) return null;
  // Older releases used updated_at for partial refreshes too. Only accept a
  // historic timestamp when it exactly matches a completed refresh log.
  const historic = row.updated_at && (row.updated_at === row.manual_at || row.updated_at === row.auto_at)
    ? String(row.updated_at) : null;
  const timestamp = row.last_success_at ? String(row.last_success_at) : historic;
  if (!timestamp) return null;
  const elapsed = now - Date.parse(timestamp);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= REFRESH_COOLDOWN_MS) return null;
  return { refreshedAt: timestamp, nextRefreshAt: new Date(Date.parse(timestamp) + REFRESH_COOLDOWN_MS).toISOString() };
}
