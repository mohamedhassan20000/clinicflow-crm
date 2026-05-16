import type { Metadata } from "next";
import Link from "next/link";
import { Archive, ChevronLeft } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { getArchivePatients } from "@/actions/patients";
import { ArchiveTable } from "@/components/patients/archive-table";

export const metadata: Metadata = { title: "Patient Archive" };

export default async function PatientArchivePage() {
  const user = await requireRole(["admin", "receptionist"]);
  const { data: patients, error } = await getArchivePatients();

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
        <Link
          href="/patients"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Patients
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold tracking-tight">Archive</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {patients?.length ?? 0} archived patient{(patients?.length ?? 0) !== 1 ? "s" : ""}.
            Full history is preserved. Archived patients do not appear in the active list.
          </p>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <ArchiveTable patients={patients ?? []} isAdmin={user.role === "admin"} />
      )}
    </div>
  );
}
