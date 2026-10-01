// Used only for reads and sync operations that can safely be retried.
export async function requestJson<T>(url: string, init: RequestInit = {}, label = 'Request'): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    let retryable = true;
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      retryable = response.status === 429 || response.status >= 500;
      const body = await response.text();
      let data: T & { error?: string };
      try { data = JSON.parse(body); }
      catch { throw new Error(`${label}: server returned an invalid response (HTTP ${response.status}).`); }
      if (!response.ok) throw new Error(`${label}: ${data.error || `HTTP ${response.status}`}`);
      return data;
    } catch (error) {
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) retryable = true;
      if (!retryable || attempt === 2) {
        if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
          throw new Error(`${label}: connection interrupted after 3 attempts. Check your connection and try again.`);
        }
        throw error;
      }
    } finally { clearTimeout(timeout); }
    await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
  }
  throw new Error(`${label} failed.`);
}
