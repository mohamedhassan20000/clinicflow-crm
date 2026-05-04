"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryState } from "nuqs";
import { useMemo, useTransition } from "react";
import {
  Search,
  UserPlus,
  ChevronLeft,
  ChevronRight,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

const UNASSIGNED_COLOR = "#94a3b8"; // slate-400
const UNASSIGNED_KEY = "__unassigned__";

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
  const isSearching = (search ?? "").trim().length > 0;

  // Group patients by department for the default browse view.
  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        deptId: string;
        name: string;
        color: string;
        patients: Patient[];
      }
    >();
    for (const p of data) {
      const dept = p.departments;
      const key = dept?.id ?? UNASSIGNED_KEY;
      if (!map.has(key)) {
        map.set(key, {
          deptId: key,
          name: dept?.name ?? "Unassigned",
          color: dept?.color ?? UNASSIGNED_COLOR,
          patients: [],
        });
      }
      map.get(key)!.patients.push(p);
    }
    // Sort: real departments alphabetically, unassigned last.
    return Array.from(map.values()).sort((a, b) => {
      if (a.deptId === UNASSIGNED_KEY) return 1;
      if (b.deptId === UNASSIGNED_KEY) return -1;
      return a.name.localeCompare(b.name);
    });
  }, [data]);

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
          <Button asChild size="sm" className="h-9 gap-1.5">
            <Link href="/patients/new">
              <UserPlus className="h-4 w-4" />
              New patient
            </Link>
          </Button>
        )}
      </div>

      {data.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card px-4 py-12 text-center text-sm text-muted-foreground">
          {isSearching
            ? "No patients match your search."
            : "No patients yet."}
        </div>
      ) : isSearching ? (
        // Search active → flat result list, hide grouped departments.
        <PatientGroupTable
          name={`Search results for "${search}"`}
          color={UNASSIGNED_COLOR}
          patients={data}
          showDepartmentBadge
          isSearch
        />
      ) : (
        // Default view → one table per department.
        <div className="space-y-5">
          {groups.map((g) => (
            <PatientGroupTable
              key={g.deptId}
              name={g.name}
              color={g.color}
              patients={g.patients}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground print:hidden">
          <span>
            {total} patient{total !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="outline"
              size="sm"
              className={`h-8 w-8 p-0 ${page <= 1 ? "pointer-events-none opacity-40" : ""}`}
            >
              <Link
                href={`?q=${search}&page=${page - 1}`}
                aria-disabled={page <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Link>
            </Button>
            <span>
              {page} / {totalPages}
            </span>
            <Button
              asChild
              variant="outline"
              size="sm"
              className={`h-8 w-8 p-0 ${page >= totalPages ? "pointer-events-none opacity-40" : ""}`}
            >
              <Link
                href={`?q=${search}&page=${page + 1}`}
                aria-disabled={page >= totalPages}
                aria-label="Next page"
              >
                <ChevronRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PatientGroupTable({
  name,
  color,
  patients,
  showDepartmentBadge = false,
  isSearch = false,
}: {
  name: string;
  color: string;
  patients: Patient[];
  showDepartmentBadge?: boolean;
  isSearch?: boolean;
}) {
  return (
    <section
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
      style={{ borderColor: `color-mix(in oklab, ${color} 35%, transparent)` }}
    >
      <header
        className="flex items-center justify-between gap-3 border-b px-4 py-3"
        style={{
          backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
          borderColor: `color-mix(in oklab, ${color} 25%, transparent)`,
        }}
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: color }}
          />
          <h3
            className="text-sm font-semibold tracking-tight"
            style={{ color }}
          >
            {name}
          </h3>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
          style={{
            backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
            color,
          }}
        >
          <Users className="h-3 w-3" />
          {patients.length} patient{patients.length !== 1 ? "s" : ""}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-24" />
            <col />
            <col className={showDepartmentBadge ? "w-28" : "w-32"} />
            {showDepartmentBadge && <col className="w-32" />}
            <col className={showDepartmentBadge ? "w-36" : "w-40"} />
            <col className={showDepartmentBadge ? "w-28" : "w-32"} />
            <col className="w-16" />
          </colgroup>
          <thead className="border-b border-border/50 bg-muted/30">
            <tr>
              <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                File #
              </th>
              <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Patient
              </th>
              <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                National ID
              </th>
              {showDepartmentBadge && (
                <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  Department
                </th>
              )}
              <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Doctor
              </th>
              <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Phone
              </th>
              <th className="px-4 py-2.5 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Blood
              </th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => (
              <PatientRow
                key={p.id}
                patient={p}
                accentColor={color}
                showDepartmentBadge={showDepartmentBadge}
                highlight={isSearch}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PatientRow({
  patient,
  accentColor,
  showDepartmentBadge,
  highlight,
}: {
  patient: Patient;
  accentColor: string;
  showDepartmentBadge: boolean;
  highlight: boolean;
}) {
  const router = useRouter();
  const href = `/patients/${patient.id}`;
  const dept = patient.departments;
  const doc = patient.assigned_doctor;
  const blood = patient.blood_type;

  function go(e: React.MouseEvent<HTMLTableRowElement>) {
    // Allow cmd/ctrl-click and middle-click to behave naturally.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.button === 1) return;
    router.push(href);
  }

  return (
    <tr
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          router.push(href);
        }
      }}
      className={cn(
        "cursor-pointer border-b border-border/30 transition-colors last:border-0",
        "hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        highlight && "bg-amber-50/40 dark:bg-amber-500/5",
      )}
    >
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-muted-foreground">
          {patient.file_number ?? "—"}
        </span>
      </td>
      <td className="max-w-0 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full ring-2 ring-background"
            style={{ backgroundColor: accentColor }}
          />
          <span className="truncate font-medium text-foreground">
            {patient.full_name}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        <span className="font-mono text-xs text-muted-foreground">
          {patient.national_id ?? "—"}
        </span>
      </td>
      {showDepartmentBadge && (
        <td className="px-4 py-3">
          {dept ? (
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
          ) : (
            <span className="text-muted-foreground/40">—</span>
          )}
        </td>
      )}
      <td className="px-4 py-3">
        {doc ? (
          <span className="text-xs text-muted-foreground">
            Dr. {doc.full_name}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="text-muted-foreground">{patient.phone ?? "—"}</span>
      </td>
      <td className="px-4 py-3">
        {blood ? (
          <Badge variant="secondary" className="font-mono text-xs">
            {blood}
          </Badge>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
    </tr>
  );
}
