import type { Metadata } from "next";
import { Archive } from "lucide-react";
import { requireRole } from "@/lib/rbac";
import { getArchivePatients } from "@/actions/patients";
import { ArchiveTable } from "@/components/patients/archive-table";
import { PageHeader } from "@/components/shared/page-header";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("protected");
  return { title: t("metadataPatientArchive") };
}

export default async function PatientArchivePage() {
  const t = await getTranslations("protected");
  const user = await requireRole(["admin", "receptionist"]);
  const { data: patients, error } = await getArchivePatients();

  return (
    <div className="space-y-6">
      <PageHeader
        back={{ href: "/patients", label: "patients" }}
        breadcrumbs={[{ label: t("patients"), href: "/patients" }, { label: t("archive2") }]}
        leading={<Archive className="mt-1 size-6 text-muted-foreground" aria-hidden="true" />}
        title={t("archive")}
        description={
          <>
            {patients?.length ?? 0} {t("archivedPatient")}{(patients?.length ?? 0) !== 1 ? "s" : ""}{t("fullHistoryIsPreservedArchivedPatients")}</>
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
