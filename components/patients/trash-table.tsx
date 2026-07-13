"use client";

import { useTransition, useState } from "react";
import Link from "next/link";
import { RotateCcw, Archive, Loader2, User } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableEmptyState } from "@/components/shared/data-table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { restorePatient, archivePatient, archiveAllTrashPatients } from "@/actions/patients";
import type { PatientStub } from "@/actions/patients";
import { withReturnTo } from "@/lib/navigation/return-url";

function daysAgo(iso: string | null): string {
  if (!iso) return "Unknown date";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${diff} days ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" });
}

type Group = { deptId: string | null; deptName: string; color: string | null; patients: PatientStub[] };

function groupByDepartment(patients: PatientStub[]): Group[] {
  const map = new Map<string, Group>();
  for (const p of patients) {
    const key = p.department_id ?? "__none__";
    if (!map.has(key)) {
      map.set(key, {
        deptId: p.department_id,
        deptName: p.departments?.name ?? "No department",
        color: p.departments?.color ?? null,
        patients: [],
      });
    }
    map.get(key)!.patients.push(p);
  }
  return Array.from(map.values());
}

interface TrashTableProps {
  patients: PatientStub[];
  isAdmin: boolean;
}

export function TrashTable({ patients, isAdmin }: TrashTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmArchiveAll, setConfirmArchiveAll] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  function handleRestore(id: string) {
    setPendingId(id);
    startTransition(async () => {
      const res = await restorePatient(id);
      setPendingId(null);
      if (res.error) toast.error(res.error);
      else { toast.success("Patient restored."); router.refresh(); }
    });
  }

  function handleArchive(id: string) {
    setPendingId(id);
    startTransition(async () => {
      const res = await archivePatient(id);
      setPendingId(null);
      if (res.error) toast.error(res.error);
      else { toast.success("Patient archived."); router.refresh(); }
    });
  }

  function handleArchiveAll() {
    setConfirmArchiveAll(false);
    startTransition(async () => {
      const res = await archiveAllTrashPatients();
      if (res.error) toast.error(res.error);
      else { toast.success("All trash patients archived."); router.refresh(); }
    });
  }

  function handleArchiveOld() {
    startTransition(async () => {
      const res = await archiveAllTrashPatients(30);
      if (res.error) toast.error(res.error);
      else { toast.success("Patients in trash for 30+ days archived."); router.refresh(); }
    });
  }

  if (patients.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/60">
        <TableEmptyState icon={User} title="Trash is empty" description="Deleted patients appear here." />
      </div>
    );
  }

  const groups = groupByDepartment(patients);

  return (
    <>
      {/* Archive actions bar (admin only) */}
      {isAdmin && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={isPending}
            onClick={handleArchiveOld}
          >
            <Archive className="h-3.5 w-3.5" />
            Archive 30+ day old
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-destructive hover:text-destructive"
            disabled={isPending}
            onClick={() => setConfirmArchiveAll(true)}
          >
            <Archive className="h-3.5 w-3.5" />
            Archive all
          </Button>
        </div>
      )}

      {groups.map((group) => (
        <div key={group.deptId ?? "__none__"} className="space-y-2">
          <div className="flex items-center gap-2">
            {group.color && (
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: group.color }} />
            )}
            <span className="text-sm font-semibold">{group.deptName}</span>
            <Badge variant="secondary" className="text-xs">{group.patients.length}</Badge>
          </div>

          <div className="overflow-hidden rounded-xl border border-border/50">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Patient</TableHead>
                  <TableHead className="hidden sm:table-cell">File #</TableHead>
                  <TableHead>Deleted</TableHead>
                  {isAdmin && <TableHead className="text-end">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.patients.map((p) => {
                  const busy = isPending && pendingId === p.id;
                  const daysOld = p.deleted_at
                    ? Math.floor((Date.now() - new Date(p.deleted_at).getTime()) / (1000 * 60 * 60 * 24))
                    : null;
                  return (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                            <User className="h-4 w-4 text-muted-foreground" />
                          </span>
                          <div className="min-w-0">
                            <Link
                              href={withReturnTo(`/patients/${p.id}`, "/patients/trash")}
                              className="truncate font-medium hover:underline"
                            >
                              {p.full_name}
                            </Link>
                            <p className="truncate text-xs text-muted-foreground">{p.phone}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                        {p.file_number}
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-sm">{daysAgo(p.deleted_at)}</p>
                          <p className="text-xs text-muted-foreground">{fmtDate(p.deleted_at)}</p>
                          {daysOld !== null && daysOld >= 30 && (
                            <Badge variant="outline" className="mt-0.5 text-[10px] border-amber-500/40 text-amber-700">
                              30+ days
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-end">
                          <div className="flex items-center justify-end gap-1.5">
                            {busy ? (
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                            ) : (
                              <>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 gap-1 text-xs"
                                  onClick={() => handleRestore(p.id)}
                                  disabled={isPending}
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  Restore
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 gap-1 text-xs"
                                  onClick={() => handleArchive(p.id)}
                                  disabled={isPending}
                                >
                                  <Archive className="h-3 w-3" />
                                  Archive
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}

      <AlertDialog open={confirmArchiveAll} onOpenChange={setConfirmArchiveAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive all trash patients?</AlertDialogTitle>
            <AlertDialogDescription>
              All {patients.length} patient{patients.length !== 1 ? "s" : ""} in trash will be moved to the Archive. This action can be undone by restoring individual patients from the Archive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchiveAll}>Archive all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
