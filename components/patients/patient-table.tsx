"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { UserPlus, ChevronLeft, ChevronRight, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableEmptyState } from "@/components/shared/data-table";
import { cn } from "@/lib/utils";
import { formatDoctorName } from "@/lib/format-doctor";
import { pathWithSearch, withReturnTo } from "@/lib/navigation/return-url";
type Patient = {
  id: string;
  file_number: string | null;
  full_name: string;
  national_id: string | null;
  phone: string | null;
  blood_type: string | null;
  department_id: string | null;
  assigned_doctor_id: string | null;
  avatar_url?: string | null;
  has_outstanding_balance?: boolean;
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
  const params = useSearchParams();
  const search =
    params.get("name") ??
    params.get("q") ??
    params.get("file") ??
    params.get("nat") ??
    params.get("phone") ??
    "";
  const totalPages = Math.ceil(total / pageSize);
  const isSearching = search.trim().length > 0;
  const returnHref = pathWithSearch("/patients", params);
  const newPatientHref = withReturnTo("/patients/new", returnHref);

  function pageHref(nextPage: number) {
    const next = new URLSearchParams(params.toString());
    if (nextPage <= 1) next.delete("page");
    else next.set("page", String(nextPage));
    return `?${next.toString()}`;
  }

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
      {canCreate && (
        <div className="flex items-center justify-end gap-3 print:hidden">
          <Button asChild size="sm" className="h-9 gap-1.5">
            <Link href={newPatientHref}>
              <UserPlus className="h-4 w-4" />
              New patient
            </Link>
          </Button>
        </div>
      )}

      {data.length === 0 ? (
        <div className="rounded-xl border border-border/50 bg-card">
          <TableEmptyState
            icon={Users}
            title={isSearching ? "No patients match your search" : "No patients yet"}
            description={
              isSearching
                ? "Try a different name, file number, national ID, or phone."
                : canCreate
                  ? "Create the first patient record to get started."
                  : "Patient records appear here once they are created."
            }
            action={
              !isSearching && canCreate ? (
                <Button asChild size="sm" className="h-9 gap-1.5">
                  <Link href={newPatientHref}>
                    <UserPlus className="h-4 w-4" />
                    New patient
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : isSearching ? (
        // Search active → flat result list, hide grouped departments.
        <PatientGroupTable
          name={`Search results for "${search}"`}
          color={UNASSIGNED_COLOR}
          patients={data}
          showDepartmentBadge
          isSearch
          returnHref={returnHref}
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
              returnHref={returnHref}
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
                href={pageHref(page - 1)}
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
                href={pageHref(page + 1)}
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
  returnHref,
}: {
  name: string;
  color: string;
  patients: Patient[];
  showDepartmentBadge?: boolean;
  isSearch?: boolean;
  returnHref: string;
}) {
  return (
    <section
      data-patient-roster-section
      className="overflow-hidden rounded-xl border bg-card shadow-sm print:rounded-none print:border-black print:shadow-none"
      style={{ borderColor: `color-mix(in oklab, ${color} 35%, transparent)` }}
    >
      <header
        className="flex items-center justify-between gap-3 border-b px-4 py-3 print:border-black print:bg-white"
        style={{
          backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
          borderColor: `color-mix(in oklab, ${color} 25%, transparent)`,
        }}
      >
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-full print:hidden"
            style={{ backgroundColor: color }}
          />
          <h3
            className="text-sm font-semibold tracking-tight print:text-black"
            style={{ color }}
          >
            {name}
          </h3>
        </div>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium print:border print:border-black print:bg-white print:text-black"
          style={{
            backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
            color,
          }}
        >
          <Users className="h-3 w-3" />
          {patients.length} patient{patients.length !== 1 ? "s" : ""}
        </span>
      </header>
      <Table className="table-fixed">
        <colgroup>
          <col className="w-24" />
          <col />
          <col className={cn("hidden md:table-column", showDepartmentBadge ? "w-28" : "w-32")} />
          {showDepartmentBadge && <col className="hidden w-32 xl:table-column" />}
          <col className={cn("hidden sm:table-column", showDepartmentBadge ? "w-36" : "w-40")} />
          <col className={cn("hidden lg:table-column", showDepartmentBadge ? "w-28" : "w-32")} />
          <col className="hidden w-16 sm:table-column" />
        </colgroup>
        <TableHeader sticky>
          <TableRow>
            <TableHead>File #</TableHead>
            <TableHead>Patient</TableHead>
            <TableHead className="hidden md:table-cell">National ID</TableHead>
            {showDepartmentBadge && <TableHead className="hidden xl:table-cell">Department</TableHead>}
            <TableHead className="hidden sm:table-cell">Doctor</TableHead>
            <TableHead className="hidden lg:table-cell">Phone</TableHead>
            <TableHead className="hidden sm:table-cell">Blood</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {patients.map((p) => (
            <PatientRow
              key={p.id}
              patient={p}
              showDepartmentBadge={showDepartmentBadge}
              highlight={isSearch}
              returnHref={returnHref}
            />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function PatientRow({
  patient,
  showDepartmentBadge,
  highlight,
  returnHref,
}: {
  patient: Patient;
  showDepartmentBadge: boolean;
  highlight: boolean;
  returnHref: string;
}) {
  const router = useRouter();
  const href = withReturnTo(`/patients/${patient.id}`, returnHref);
  const dept = patient.departments;
  const doc = patient.assigned_doctor;
  const blood = patient.blood_type;

  function go(e: React.MouseEvent<HTMLTableRowElement>) {
    // Allow cmd/ctrl-click and middle-click to behave naturally.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.button === 1) return;
    router.push(href);
  }

  return (
    <TableRow
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
        "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        highlight && "bg-amber-50/40 dark:bg-amber-500/5",
      )}
    >
      <TableCell>
        <span className="font-mono text-xs text-muted-foreground">
          {patient.file_number ?? "—"}
        </span>
      </TableCell>
      <TableCell className="max-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar className="h-8 w-8 print:hidden">
            {patient.avatar_url && (
              <AvatarImage
                src={patient.avatar_url}
                alt={`${patient.full_name} avatar`}
              />
            )}
            <AvatarFallback className="border border-border/80 bg-muted text-muted-foreground">
              <UserRound className="size-4" aria-hidden="true" />
            </AvatarFallback>
          </Avatar>
          <span className="truncate font-medium text-foreground">
            {patient.full_name}
          </span>
          {patient.has_outstanding_balance && (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-300 print:border-black print:bg-white print:text-black"
            >
              Balance
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <span className="font-mono text-xs text-muted-foreground">
          {patient.national_id ?? "—"}
        </span>
      </TableCell>
      {showDepartmentBadge && (
        <TableCell className="hidden xl:table-cell">
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
        </TableCell>
      )}
      <TableCell className="hidden sm:table-cell">
        {doc ? (
          <span className="text-xs text-muted-foreground">
            {formatDoctorName(doc.full_name)}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <span className="whitespace-nowrap text-muted-foreground">
          {patient.phone ?? "—"}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {blood ? (
          <Badge variant="secondary" className="font-mono text-xs">
            {blood}
          </Badge>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}
