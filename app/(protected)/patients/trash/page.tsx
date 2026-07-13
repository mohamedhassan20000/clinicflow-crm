import type { Metadata } from "next";
import { Trash2 } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { getTrashPatients } from "@/actions/patients";
import { TrashTable } from "@/components/patients/trash-table";
import { PageHeader } from "@/components/shared/page-header";

export const metadata: Metadata = { title: "Patient Trash" };

export default async function PatientTrashPage() {
  const user = await requireRole(["admin", "receptionist"]);
  const { data: patients, error } = await getTrashPatients();

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/patients", label: "patients" }}
        breadcrumbs={[{ label: "Patients", href: "/patients" }, { label: "Trash" }]}
        leading={<Trash2 className="mt-1 size-6 text-muted-foreground" aria-hidden="true" />}
        title="Trash"
        description={
          <>
            {patients?.length ?? 0} deleted patient{(patients?.length ?? 0) !== 1 ? "s" : ""}.
            No patient files or history are permanently removed.
          </>
        }
      />

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : (
        <TrashTable patients={patients ?? []} isAdmin={user.role === "admin"} />
      )}
    </div>
  );
}
