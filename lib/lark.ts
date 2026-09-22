import { env } from 'cloudflare:workers';
import type { CountryCode } from '@/lib/countries';

const DEFAULT_BASE_TOKEN = 'RM2Rbbj9RauDqKsAloPjWMHCp3f';
const DEFAULT_TABLE_ID = 'tblBJUDAOmKGqddt';

export const LARK_FIELDS = {
  sku: 'SKU',
  cost: 'cost',
  warehouse: 'warehouse',
  logistics: { SE: 'SE logistic fee', DK: 'DK logistic fee', FI: 'FI logistic fee', NO: 'NO logistic fee' },
  chemicalTaxSe: 'CHEMICAL TAX-SE',
  copySwe: 'copy-swe',
  copyDk: 'copy-dk',
  fixedFee: 'mistore fixed fee',
  rabatt: 'rabatt',
  salePrice: { SE: 'SE-sale price', DK: 'dk-sale price', FI: 'fi-sale price', NO: 'no-sale price' },
} as const;

type LarkEnvironment = {
  LARK_APP_ID?: string;
  LARK_APP_SECRET?: string;
  LARK_BASE_TOKEN?: string;
  LARK_PRICEDESK_TABLE_ID?: string;
};

type LarkRecord = { record_id: string; fields: Record<string, unknown> };

function settings() {
  const current = env as unknown as LarkEnvironment;
  return {
    appId: current.LARK_APP_ID?.trim() ?? '',
    appSecret: current.LARK_APP_SECRET?.trim() ?? '',
    baseToken: current.LARK_BASE_TOKEN?.trim() || DEFAULT_BASE_TOKEN,
    tableId: current.LARK_PRICEDESK_TABLE_ID?.trim() || DEFAULT_TABLE_ID,
  };
}

export function isLarkConfigured() {
  const current = settings();
  return Boolean(current.appId && current.appSecret);
}

async function larkToken() {
  const current = settings();
  if (!current.appId || !current.appSecret) throw new Error('Lark is not connected. Add LARK_APP_ID and LARK_APP_SECRET.');
  const response = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: current.appId, app_secret: current.appSecret }),
  });
  const payload = await response.json() as { code?: number; msg?: string; tenant_access_token?: string };
  if (!response.ok || payload.code !== 0 || !payload.tenant_access_token) throw new Error(`Lark authentication failed: ${payload.msg || response.status}`);
  return payload.tenant_access_token;
}

async function larkRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await larkToken();
  const response = await fetch(`https://open.larksuite.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8', ...(init?.headers ?? {}) },
  });
  const payload = await response.json() as { code?: number; msg?: string; data?: T };
  if (!response.ok || payload.code !== 0 || payload.data == null) throw new Error(`Lark API failed: ${payload.msg || response.status}`);
  return payload.data;
}

export async function listPriceDeskRecords() {
  const current = settings();
  const records: LarkRecord[] = [];
  let pageToken = '';
  do {
    const query = new URLSearchParams({ page_size: '500' });
    if (pageToken) query.set('page_token', pageToken);
    const result = await larkRequest<{ items?: LarkRecord[]; has_more?: boolean; page_token?: string }>(
      `/open-apis/bitable/v1/apps/${current.baseToken}/tables/${current.tableId}/records?${query}`,
    );
    records.push(...(result.items ?? []));
    pageToken = result.has_more ? result.page_token ?? '' : '';
  } while (pageToken);
  return records;
}

export async function writeExpectedPrices(country: CountryCode, expectedPriceMinor: number | null, recordIds: string[]) {
  const current = settings();
  const field = LARK_FIELDS.salePrice[country];
  const value = expectedPriceMinor == null ? null : expectedPriceMinor / 100;
  const results: Array<{ recordId: string; ok: boolean; error?: string }> = [];
  for (const recordId of recordIds) {
    try {
      await larkRequest<{ record: LarkRecord }>(
        `/open-apis/bitable/v1/apps/${current.baseToken}/tables/${current.tableId}/records/${recordId}`,
        { method: 'PUT', body: JSON.stringify({ fields: { [field]: value } }) },
      );
      results.push({ recordId, ok: true });
    } catch (error) {
      results.push({ recordId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export function larkNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function larkText(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' && item && 'text' in item ? String((item as { text: unknown }).text) : String(item)).join('').trim();
  return '';
}
