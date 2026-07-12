import type { OperatorReportDefinition, ReportRow } from "@/lib/operator-reports/types";

export function ReportShell({ definition, rows }: { definition: OperatorReportDefinition; rows: ReportRow[] }) {
  return (
    <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b p-5">
        <div><h2 className="text-lg font-semibold">{definition.title}</h2><p className="text-sm text-muted-foreground">{definition.description}</p></div>
        <a href={`/operator/reports/${definition.id}/export`} className="rounded-lg border px-3 py-2 text-sm font-medium hover:bg-muted">Export CSV</a>
      </div>
      <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="bg-muted/50"><tr>{definition.columns.map((column) => <th key={column.key} className="px-5 py-3 text-start font-medium text-muted-foreground">{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} className="border-t">{definition.columns.map((column) => <td key={column.key} className="px-5 py-3">{String(row[column.key] ?? "—")}</td>)}</tr>)}</tbody></table></div>
      {rows.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">No records.</p> : null}
    </section>
  );
}
