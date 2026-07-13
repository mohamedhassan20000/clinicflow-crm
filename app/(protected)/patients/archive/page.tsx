import type { Metadata } from "next";
import { Archive } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { getArchivePatients } from "@/actions/patients";
import { ArchiveTable } from "@/components/patients/archive-table";
import { PageHeader } from "@/components/shared/page-header";

export const metadata: Metadata = { title: "Patient Archive" };

export default async function PatientArchivePage() {
  const user = await requireRole(["admin", "receptionist"]);
  const { data: patients, error } = await getArchivePatients();

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/patients", label: "patients" }}
        breadcrumbs={[{ label: "Patients", href: "/patients" }, { label: "Archive" }]}
        leading={<Archive className="mt-1 size-6 text-muted-foreground" aria-hidden="true" />}
        title="Archive"
        description={
          <>
            {patients?.length ?? 0} archived patient{(patients?.length ?? 0) !== 1 ? "s" : ""}.
            Full history is preserved. Archived patients do not appear in the active list.
          </>
        }
      />

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
