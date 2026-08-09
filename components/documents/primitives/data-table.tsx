import type { ReactNode } from "react";

export type DocumentTableColumn = {
  key: string;
  label: ReactNode;
  align?: "start" | "center" | "end";
  direction?: "auto" | "ltr" | "rtl";
  width?: string;
};

export type DocumentTableRow = {
  id: string;
  cells: Readonly<Record<string, ReactNode>>;
};

export function DataTable({
  columns,
  rows,
  totals,
  emptyLabel,
  caption,
}: {
  columns: readonly DocumentTableColumn[];
  rows: readonly DocumentTableRow[];
  totals?: Readonly<Record<string, ReactNode>>;
  emptyLabel: string;
  caption?: string;
}) {
  if (columns.length === 0) return null;
  return (
    <div className="cf-doc-table-wrap" data-testid="data-table">
      <table className="cf-doc-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <colgroup>
          {columns.map((column) => <col key={column.key} style={{ width: column.width }} />)}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" data-align={column.align || "start"}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="cf-doc-empty" colSpan={columns.length}>{emptyLabel}</td></tr>
          ) : rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  data-align={column.align || "start"}
                  data-direction={column.direction || "auto"}
                >
                  {column.direction === "ltr" ? (
                    <bdi className="cf-doc-ltr">{row.cells[column.key] ?? "—"}</bdi>
                  ) : row.cells[column.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {totals && (
          <tfoot>
            <tr>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={
                    column.align !== "end" && totals[column.key]
                      ? "cf-doc-table-total-label"
                      : undefined
                  }
                  data-align={column.align || "start"}
                  data-direction={column.direction || "auto"}
                >
                  {totals[column.key] ?? ""}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
