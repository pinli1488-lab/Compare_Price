export const LARK_COST_COLUMNS = [
  'cost_sek_minor', 'warehouse_sek_minor',
  'se_logistics_sek_minor', 'dk_logistics_sek_minor', 'fi_logistics_sek_minor', 'no_logistics_sek_minor',
  'chemical_tax_se_sek_minor', 'copy_swe_sek_minor', 'copy_dk_sek_minor',
  'fixed_fee_sek_minor', 'rabatt_sek_minor',
] as const;

export function equalCostValues(rows: Array<Array<number | null>>): boolean {
  if (!rows.length) return false;
  return rows.every((row) => row.length === rows[0].length && row.every((value, index) =>
    (value === null || Number.isFinite(value)) && value === rows[0][index]));
}

export function larkCostRowsAgree(rows: Record<string, unknown>[]): boolean {
  return equalCostValues(rows.map((row) => LARK_COST_COLUMNS.map((field) => {
    const value = row[field];
    return value == null ? null : typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value) : NaN;
  })));
}
