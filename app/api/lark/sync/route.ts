import { ensureSchema, getD1 } from '@/db/store';
import { isLarkConfigured, LARK_FIELDS, larkNumber, larkText, listPriceDeskRecords } from '@/lib/lark';

export const runtime = 'edge';

const toMinor = (value: unknown) => {
  const number = larkNumber(value);
  return number == null ? null : Math.round(number * 100);
};

export async function GET() {
  await ensureSchema();
  const row = await getD1().prepare("SELECT last_synced_at,last_error FROM integration_status WHERE integration='lark'").first();
  return Response.json({ configured: isLarkConfigured(), lastSyncedAt: row?.last_synced_at ?? null, lastError: row?.last_error ?? null });
}

export async function POST() {
  await ensureSchema();
  if (!isLarkConfigured()) return Response.json({ error: 'Lark is not connected. Add LARK_APP_ID and LARK_APP_SECRET.' }, { status: 503 });
  try {
    const records = await listPriceDeskRecords();
    const now = new Date().toISOString();
    const rows = records.map((record) => {
      const fields = record.fields;
      const sku = larkText(fields[LARK_FIELDS.sku]);
      return { recordId: record.record_id, sku, normalized: sku.toLowerCase(),
        values: [toMinor(fields[LARK_FIELDS.cost]), toMinor(fields[LARK_FIELDS.warehouse]),
          toMinor(fields[LARK_FIELDS.logistics.SE]), toMinor(fields[LARK_FIELDS.logistics.DK]),
          toMinor(fields[LARK_FIELDS.logistics.FI]), toMinor(fields[LARK_FIELDS.logistics.NO]),
          toMinor(fields[LARK_FIELDS.chemicalTaxSe]), toMinor(fields[LARK_FIELDS.copySwe]),
          toMinor(fields[LARK_FIELDS.copyDk]), toMinor(fields[LARK_FIELDS.fixedFee]), toMinor(fields[LARK_FIELDS.rabatt])],
      };
    }).filter((row) => row.sku);
    for (let index = 0; index < rows.length; index += 60) {
      await getD1().batch(rows.slice(index, index + 60).map((row) => getD1().prepare(`INSERT INTO lark_product_costs (
        record_id,sku,sku_normalized,cost_sek_minor,warehouse_sek_minor,se_logistics_sek_minor,dk_logistics_sek_minor,
        fi_logistics_sek_minor,no_logistics_sek_minor,chemical_tax_se_sek_minor,copy_swe_sek_minor,copy_dk_sek_minor,
        fixed_fee_sek_minor,rabatt_sek_minor,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(record_id) DO UPDATE SET sku=excluded.sku,sku_normalized=excluded.sku_normalized,
        cost_sek_minor=excluded.cost_sek_minor,warehouse_sek_minor=excluded.warehouse_sek_minor,
        se_logistics_sek_minor=excluded.se_logistics_sek_minor,dk_logistics_sek_minor=excluded.dk_logistics_sek_minor,
        fi_logistics_sek_minor=excluded.fi_logistics_sek_minor,no_logistics_sek_minor=excluded.no_logistics_sek_minor,
        chemical_tax_se_sek_minor=excluded.chemical_tax_se_sek_minor,copy_swe_sek_minor=excluded.copy_swe_sek_minor,
        copy_dk_sek_minor=excluded.copy_dk_sek_minor,fixed_fee_sek_minor=excluded.fixed_fee_sek_minor,
        rabatt_sek_minor=excluded.rabatt_sek_minor,updated_at=excluded.updated_at`)
        .bind(row.recordId, row.sku, row.normalized, ...row.values, now)));
    }
    await getD1().prepare('DELETE FROM lark_product_costs WHERE updated_at <> ?').bind(now).run();
    const duplicates = rows.length - new Set(rows.map((row) => row.normalized)).size;
    await getD1().prepare(`INSERT INTO integration_status(integration,last_synced_at,last_error) VALUES('lark',?,NULL)
      ON CONFLICT(integration) DO UPDATE SET last_synced_at=excluded.last_synced_at,last_error=NULL`).bind(now).run();
    return Response.json({ synced: rows.length, skipped: records.length - rows.length, duplicateRows: duplicates, lastSyncedAt: now });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getD1().prepare(`INSERT INTO integration_status(integration,last_error) VALUES('lark',?)
      ON CONFLICT(integration) DO UPDATE SET last_error=excluded.last_error`).bind(message).run();
    return Response.json({ error: message }, { status: 502 });
  }
}
