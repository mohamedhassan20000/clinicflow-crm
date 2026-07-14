import type { Metadata } from "next";
import { Trash2 } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { getTrashPatients } from "@/actions/patients";
import { TrashTable } from "@/components/patients/trash-table";
import { PageHeader } from "@/components/shared/page-header";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataPatientTrash") };
}

export default async function PatientTrashPage() {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "receptionist"]);
  const { data: patients, error } = await getTrashPatients();

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/patients", label: "patients" }}
        breadcrumbs={[{ label: t("patients"), href: "/patients" }, { label: t("trash2") }]}
        leading={<Trash2 className="mt-1 size-6 text-muted-foreground" aria-hidden="true" />}
        title={t("trash")}
        description={
          <>
            {patients?.length ?? 0} {t("deletedPatient")}{(patients?.length ?? 0) !== 1 ? "s" : ""}{t("noPatientFilesOrHistoryAre")}</>
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
