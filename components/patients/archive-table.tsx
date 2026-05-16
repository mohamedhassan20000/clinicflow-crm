"use client";

import { useTransition, useState } from "react";
import Link from "next/link";
import { RotateCcw, Loader2, User } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { restoreArchivedPatient } from "@/actions/patients";
import type { PatientStub } from "@/actions/patients";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium" });
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "Unknown date";
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 30) return `${diff} days ago`;
  const months = Math.floor(diff / 30);
  return months === 1 ? "1 month ago" : `${months} months ago`;
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

interface ArchiveTableProps {
  patients: PatientStub[];
  isAdmin: boolean;
}

export function ArchiveTable({ patients, isAdmin }: ArchiveTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  function handleRestore(id: string) {
    setPendingId(id);
    startTransition(async () => {
      const res = await restoreArchivedPatient(id);
      setPendingId(null);
      if (res.error) toast.error(res.error);
      else { toast.success("Patient restored to active list."); router.refresh(); }
    });
  }

  if (patients.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-16 text-center">
        <p className="text-sm font-medium text-muted-foreground">Archive is empty</p>
        <p className="mt-1 text-xs text-muted-foreground/70">Archived patients appear here.</p>
      </div>
    );
  }

  const groups = groupByDepartment(patients);

  return (
    <div className="space-y-6">
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
            <table className="w-full table-auto text-sm">
              <thead>
                <tr className="border-b border-border/50 bg-muted/30">
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Patient</th>
                  <th className="hidden px-4 py-2.5 text-left font-medium text-muted-foreground sm:table-cell">File #</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Archived</th>
                  {isAdmin && <th className="px-4 py-2.5 text-right font-medium text-muted-foreground">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {group.patients.map((p) => {
                  const busy = isPending && pendingId === p.id;
                  return (
                    <tr key={p.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/10">
                            <User className="h-4 w-4 text-amber-700" />
                          </span>
                          <div className="min-w-0">
                            <Link
                              href={`/patients/${p.id}`}
                              className="truncate font-medium hover:underline"
                            >
                              {p.full_name}
                            </Link>
                            <p className="truncate text-xs text-muted-foreground">{p.phone}</p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 font-mono text-xs text-muted-foreground sm:table-cell">
                        {p.file_number}
                      </td>
                      <td className="px-4 py-3">
                        <div>
                          <p className="text-sm">{fmtRelative(p.archived_at)}</p>
                          <p className="text-xs text-muted-foreground">{fmtDate(p.archived_at)}</p>
                        </div>
                      </td>
                      {isAdmin && (
                        <td className="px-4 py-3 text-right">
                          {busy ? (
                            <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
                          ) : (
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
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
