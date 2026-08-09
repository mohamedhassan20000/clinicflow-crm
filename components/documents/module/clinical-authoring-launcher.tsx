"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  LabRequestForm,
  PrescriptionForm,
  SickLeaveForm,
} from "@/components/clinical";
import type { ClinicalAuthoringOptions } from "@/actions/clinical/authoring";
import type { P76ClinicalDocumentCode } from "@/lib/documents/resolvers/clinical-document";
import { saveDocumentDraft } from "@/actions/document-drafts";
import type {
  LabRequestDraftInput,
  PrescriptionDraftInput,
  SickLeaveDraftInput,
} from "@/lib/validations/clinical";

type Props = {
  documentType: P76ClinicalDocumentCode;
  options: ClinicalAuthoringOptions;
  allowsExternalSubject: boolean;
  locale: "ar" | "en";
  draftId?: string;
  recordId?: string;
  initial?: PrescriptionDraftInput | LabRequestDraftInput | SickLeaveDraftInput;
};

/**
 * P7-8 clinical-authoring dispatch. Thin caller: it mounts the SHARED
 * `components/clinical/*` form (the single owner of validation/persistence/RLS,
 * doc 16 §5), and on a saved draft hands the record id straight to the existing
 * clinical document preview surface — no issuance or business logic here.
 */
export function ClinicalAuthoringLauncher({
  documentType,
  options,
  allowsExternalSubject,
  locale,
  draftId,
  recordId,
  initial,
}: Props) {
  const t = useTranslations("documents.module.clinical");
  const router = useRouter();

  async function goToPreview(savedRecordId: string) {
    const saved = await saveDocumentDraft({
      draftId,
      documentType,
      locale,
      params: { recordId: savedRecordId },
    });
    if (saved.data) router.push(saved.data.previewHref);
  }

  let form: React.ReactNode = null;
  if (documentType === "PRESCRIPTION") {
    form = (
      <PrescriptionForm
        doctors={options.doctors}
        patients={options.patients}
        appointments={options.appointments}
        catalog={options.drugs}
        allowsExternalSubject={allowsExternalSubject}
        recordId={recordId}
        initial={initial as PrescriptionDraftInput | undefined}
        onSaved={goToPreview}
      />
    );
  } else if (documentType === "LAB_REQUEST") {
    form = (
      <LabRequestForm
        doctors={options.doctors}
        patients={options.patients}
        appointments={options.appointments}
        catalog={options.labTests}
        allowsExternalSubject={allowsExternalSubject}
        recordId={recordId}
        initial={initial as LabRequestDraftInput | undefined}
        onSaved={goToPreview}
      />
    );
  } else {
    form = (
      <SickLeaveForm
        doctors={options.doctors}
        patients={options.patients}
        appointments={options.appointments}
        allowsExternalSubject={allowsExternalSubject}
        recordId={recordId}
        initial={initial as SickLeaveDraftInput | undefined}
        onSaved={goToPreview}
      />
    );
  }

  return (
    <section className="rounded-xl border bg-card p-5">
      <h2 className="mb-1 font-semibold">{t("formHeading")}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{t("formSubtitle")}</p>
      {form}
    </section>
  );
}
