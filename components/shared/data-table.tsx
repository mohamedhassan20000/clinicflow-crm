import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Shared empty state for tables and lists (Pre-P2 WS2): icon + one-line
 * explanation + optional action, rendered inside the table region so screen
 * readers and sighted users get the same answer to "why is this empty?".
 *
 * `compact` renders the same content as a single horizontal row instead of a
 * tall centred block. It exists for places that stack several possibly-empty
 * lists together — the owner clinic History tab is the case that forced it —
 * where three full-height empty states push the real content off the screen.
 */
export function TableEmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div
        data-slot="table-empty-compact"
        className={cn("flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-3 text-start", className)}
      >
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {action ? <div className="ms-auto">{action}</div> : null}
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="max-w-sm text-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Loading placeholder matching the shared table rhythm. */
export function TableSkeleton({ columns = 4, rows = 5, className }: { columns?: number; rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-0", className)} aria-hidden="true">
      <div className="flex gap-4 bg-muted px-4 py-3.5">
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-border/50 px-4 py-3.5 last:border-0">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton key={c} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export type DataTableColumn<Row> = {
  key: string;
  label: React.ReactNode;
  ariaSort?: "ascending" | "descending" | "none";
  /** Right-aligned tabular numbers for amounts/counts. */
  numeric?: boolean;
  headClassName?: string;
  cellClassName?: string;
  render?: (row: Row) => React.ReactNode;
};

/**
 * Light declarative wrapper over the shared table primitives for uniform
 * data-listing surfaces (operator reports, registries). Column defs drive the
 * header and cells; empty state is built in. Complex tables (row actions,
 * grouped rows) should compose the primitives directly instead.
 */
export function DataTable<Row extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  caption,
  stickyHeader,
  empty,
}: {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey?: (row: Row, index: number) => string;
  caption?: string;
  stickyHeader?: boolean;
  empty: { title: string; description?: string; icon?: LucideIcon; action?: React.ReactNode; compact?: boolean };
}) {
  if (rows.length === 0) {
    return <TableEmptyState {...empty} />;
  }

  return (
    <Table>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <TableHeader sticky={stickyHeader}>
        <TableRow>
          {columns.map((column) => (
            <TableHead
              key={column.key}
              aria-sort={column.ariaSort}
              className={cn(column.numeric && "text-end", column.headClassName)}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={rowKey ? rowKey(row, index) : index}>
            {columns.map((column) => (
              <TableCell
                key={column.key}
                className={cn(column.numeric && "text-end tabular-nums", column.cellClassName)}
              >
                {column.render ? column.render(row) : String(row[column.key] ?? "—")}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
