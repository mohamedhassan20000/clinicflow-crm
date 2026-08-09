import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { listClinicalAuthoringOptions } from "@/actions/clinical/authoring";
import { ClinicalAuthoringLauncher } from "@/components/documents/module/clinical-authoring-launcher";
import { Button } from "@/components/ui/button";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { requireClinicalRead } from "@/actions/clinical/_shared";
import type { P76ClinicalDocumentCode } from "@/lib/documents/resolvers/clinical-document";
import { getDocumentTypeLabels } from "@/lib/documents/module-labels";
import type { Locale } from "@/lib/i18n/config";
import { getClinicDocumentDraft } from "@/actions/document-drafts";
import { getPrescription } from "@/actions/clinical/prescriptions";
import { getLabRequest } from "@/actions/clinical/lab-requests";
import { getSickLeave } from "@/actions/clinical/sick-leaves";
import type {
  LabRequestDraftInput,
  PrescriptionDraftInput,
  SickLeaveDraftInput,
} from "@/lib/validations/clinical";

const SLUGS = {
  prescription: "PRESCRIPTION",
  "lab-request": "LAB_REQUEST",
  "sick-leave": "SICK_LEAVE_CERTIFICATE",
} as const satisfies Record<string, P76ClinicalDocumentCode>;

type Slug = keyof typeof SLUGS;

function isSlug(value: string): value is Slug {
  return Object.hasOwn(SLUGS, value);
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("documents.module.clinical");
  return { title: t("title") };
}

export default async function NewClinicalDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ draftId?: string }>;
}) {
  const [{ slug }, sp, t, defaultLocale, typeLabels] = await Promise.all([
    params,
    searchParams,
    getTranslations("documents.module.clinical"),
    getLocale() as Promise<Locale>,
    getDocumentTypeLabels(),
  ]);
  if (!isSlug(slug)) notFound();
  const documentType = SLUGS[slug];

  // Preparer-role gate (Admin/Manager/Receptionist/Doctor/Assistant) — the same
  // authorization the shared clinical actions enforce on write.
  const user = await requireClinicalRead();
  const catalog = getDocumentCatalogEntry(documentType);
  if (!catalog.pageRoles.includes(user.role)) notFound();

  const options = await listClinicalAuthoringOptions();
  const draftResult = sp.draftId ? await getClinicDocumentDraft(sp.draftId) : null;
  const draft = draftResult?.data;
  if (sp.draftId && (!draft || draft.documentType !== documentType)) notFound();
  const recordId = typeof draft?.params.recordId === "string"
    ? draft.params.recordId
    : undefined;
  let initial: PrescriptionDraftInput | LabRequestDraftInput | SickLeaveDraftInput | undefined;
  if (recordId && documentType === "PRESCRIPTION") {
    const record = (await getPrescription(recordId)).data;
    if (!record || record.status !== "draft") notFound();
    initial = {
      responsible_doctor_id: record.responsible_doctor_id,
      appointment_id: record.appointment_id,
      patient_id: record.patient_id,
      subject_full_name: record.subject_full_name,
      subject_dob: record.subject_dob,
      subject_national_id: record.subject_national_id,
      valid_until: record.valid_until,
      notes: record.notes,
      medications: record.prescription_medications,
    };
  } else if (recordId && documentType === "LAB_REQUEST") {
    const record = (await getLabRequest(recordId)).data;
    if (!record || record.status !== "draft") notFound();
    initial = {
      responsible_doctor_id: record.responsible_doctor_id,
      appointment_id: record.appointment_id,
      patient_id: record.patient_id,
      subject_full_name: record.subject_full_name,
      subject_dob: record.subject_dob,
      subject_national_id: record.subject_national_id,
      priority: record.priority as "routine" | "urgent" | "stat",
      laboratory_name: record.laboratory_name,
      clinical_context: record.clinical_context,
      instructions: record.instructions,
      tests: record.lab_request_tests,
    };
  } else if (recordId && documentType === "SICK_LEAVE_CERTIFICATE") {
    const record = (await getSickLeave(recordId)).data;
    if (!record || record.status !== "draft") notFound();
    initial = {
      responsible_doctor_id: record.responsible_doctor_id,
      appointment_id: record.appointment_id,
      patient_id: record.patient_id,
      subject_full_name: record.subject_full_name,
      subject_dob: record.subject_dob,
      subject_national_id: record.subject_national_id,
      leave_start_date: record.leave_start_date,
      leave_end_date: record.leave_end_date,
      recipient_organization: record.recipient_organization,
      recipient_reference: record.recipient_reference,
      restrictions: record.restrictions,
      return_date: record.return_date,
    };
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Button asChild variant="ghost" size="sm">
          <Link href="/documents/new">
            <ArrowLeft className="rtl:rotate-180" data-icon="inline-start" />
            {t("back")}
          </Link>
        </Button>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {t("prepare", { name: typeLabels[documentType] })}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <ClinicalAuthoringLauncher
        documentType={documentType}
        options={options}
        allowsExternalSubject={catalog.allowsExternalSubject ?? false}
        locale={draft?.locale ?? defaultLocale}
        draftId={draft?.id}
        recordId={recordId}
        initial={initial}
      />
    </div>
  );
}
