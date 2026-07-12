export type ReportCell = string | number | null;
export type ReportRow = Record<string, ReportCell>;

export type OperatorReportDefinition = {
  id: string;
  title: string;
  description: string;
  columns: readonly { key: string; label: string }[];
  query: () => Promise<ReportRow[]>;
  export: (rows: ReportRow[]) => string;
};

export function exportReportCsv(definition: OperatorReportDefinition, rows: ReportRow[]) {
  const escape = (value: ReportCell) => {
    const raw = String(value ?? "");
    const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  return [definition.columns.map((column) => escape(column.label)).join(","), ...rows.map((row) => definition.columns.map((column) => escape(row[column.key])).join(","))].join("\n");
}
