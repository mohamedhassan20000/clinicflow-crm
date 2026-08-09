import { DataTable, type DocumentTableColumn, type DocumentTableRow } from "./data-table";

export type DocumentTableGroup = {
  id: string;
  title: string;
  countLabel?: string;
  rows: readonly DocumentTableRow[];
};

export function GroupedTables({
  columns,
  groups,
  emptyLabel,
}: {
  columns: readonly DocumentTableColumn[];
  groups: readonly DocumentTableGroup[];
  emptyLabel: string;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="cf-doc-grouped-tables" data-testid="grouped-tables">
      {groups.map((group) => (
        <section className="cf-doc-section" key={group.id}>
          <div className="cf-doc-group-heading">
            <span>{group.title}</span>
            {group.countLabel && <bdi className="cf-doc-group-count">{group.countLabel}</bdi>}
          </div>
          <DataTable columns={columns} rows={group.rows} emptyLabel={emptyLabel} />
        </section>
      ))}
    </div>
  );
}
