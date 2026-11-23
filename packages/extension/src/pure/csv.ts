// CSV for extract.table format=csv (RFC 4180 quoting, "\n" line breaks).
export function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  return [headers.map(csvCell).join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n");
}
