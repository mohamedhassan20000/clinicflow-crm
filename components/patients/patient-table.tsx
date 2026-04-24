"use client";

import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  type ColumnDef,
} from "@tanstack/react-table";
import Link from "next/link";
import { useQueryState } from "nuqs";
import { useTransition } from "react";
import { Search, UserPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { Tables } from "@/types/database";

type Patient = Tables<"patients"> & {
  departments?: { id: string; name: string; color: string } | null;
  assigned_doctor?: { id: string; full_name: string } | null;
};

interface PatientTableProps {
  data: Patient[];
  total: number;
  page: number;
  pageSize: number;
  canCreate: boolean;
}

const columns: ColumnDef<Patient>[] = [
  {
    id: "file_number",
    header: "File #",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.file_number ?? "—"}
      </span>
    ),
  },
  {
    accessorKey: "full_name",
    header: "Patient",
    cell: ({ row }) => {
      const dept = row.original.departments;
      return (
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full ring-2 ring-background"
            style={{ backgroundColor: dept?.color ?? "var(--muted-foreground)" }}
            title={dept?.name ?? "Unassigned"}
          />
          <Link
            href={`/patients/${row.original.id}`}
            className="font-medium text-foreground hover:text-primary transition-colors"
          >
            {row.original.full_name}
          </Link>
        </div>
      );
    },
  },
  {
    id: "national_id",
    header: "National ID",
    cell: ({ row }) => (
      <span className="font-mono text-xs text-muted-foreground">
        {row.original.national_id ?? "—"}
      </span>
    ),
  },
  {
    id: "department",
    header: "Department",
    cell: ({ row }) => {
      const dept = row.original.departments;
      if (!dept) return <span className="text-muted-foreground/40">—</span>;
      return (
        <Badge
          variant="outline"
          className="gap-1.5 font-normal"
          style={{
            borderColor: `color-mix(in oklab, ${dept.color} 45%, transparent)`,
            backgroundColor: `color-mix(in oklab, ${dept.color} 10%, transparent)`,
            color: dept.color,
          }}
        >
          {dept.name}
        </Badge>
      );
    },
  },
  {
    id: "doctor",
    header: "Doctor",
    cell: ({ row }) => {
      const doc = row.original.assigned_doctor;
      if (!doc) return <span className="text-muted-foreground/40">—</span>;
      return (
        <span className="text-xs text-muted-foreground">
          Dr. {doc.full_name}
        </span>
      );
    },
  },
  {
    accessorKey: "phone",
    header: "Phone",
    cell: ({ getValue }) => (
      <span className="text-muted-foreground">{getValue<string>()}</span>
    ),
  },
  {
    accessorKey: "blood_type",
    header: "Blood",
    cell: ({ getValue }) => {
      const bt = getValue<string | null>();
      if (!bt) return <span className="text-muted-foreground/40">—</span>;
      return (
        <Badge variant="secondary" className="font-mono text-xs">
          {bt}
        </Badge>
      );
    },
  },
  {
    id: "actions",
    cell: ({ row }) => (
      <Link href={`/patients/${row.original.id}`}>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
          View
        </Button>
      </Link>
    ),
  },
];

export function PatientTable({
  data,
  total,
  page,
  pageSize,
  canCreate,
}: PatientTableProps) {
  const [search, setSearch] = useQueryState("q", { defaultValue: "" });
  const [, startTransition] = useTransition();
  const totalPages = Math.ceil(total / pageSize);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    rowCount: total,
  });

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 print:hidden">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, phone, file #, national ID…"
            value={search}
            onChange={(e) =>
              startTransition(() => void setSearch(e.target.value || null))
            }
            className="h-9 pl-9"
          />
        </div>
        {canCreate && (
          <Link href="/patients/new">
            <Button size="sm" className="h-9 gap-1.5">
              <UserPlus className="h-4 w-4" />
              New patient
            </Button>
          </Link>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border/50 bg-muted/30">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground"
                  >
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext(),
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-sm text-muted-foreground"
                >
                  {search ? "No patients match your search." : "No patients yet."}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border/30 last:border-0 hover:bg-muted/20 transition-colors"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground print:hidden">
          <span>
            {total} patient{total !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-2">
            <Link
              href={`?q=${search}&page=${page - 1}`}
              aria-disabled={page <= 1}
              className={page <= 1 ? "pointer-events-none opacity-40" : ""}
            >
              <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </Link>
            <span>
              {page} / {totalPages}
            </span>
            <Link
              href={`?q=${search}&page=${page + 1}`}
              aria-disabled={page >= totalPages}
              className={
                page >= totalPages ? "pointer-events-none opacity-40" : ""
              }
            >
              <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
