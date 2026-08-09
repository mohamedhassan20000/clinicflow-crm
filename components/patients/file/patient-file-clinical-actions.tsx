"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, FlaskConical, Stethoscope } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  LabRequestForm,
  PrescriptionForm,
  SickLeaveForm,
} from "@/components/clinical";
import type { ClinicalAuthoringOptions } from "@/actions/clinical/authoring";

type ClinicalKind = "prescription" | "lab-request" | "sick-leave";

interface Props {
  patientId: string;
  patientName: string;
  fileNumber: string | null;
  /** Authoring reference data (doctors + catalogs), pre-filtered to this patient's appointments. */
  options: ClinicalAuthoringOptions;
  locale: "ar" | "en";
}

/**
 * P7-11 — contextual clinical actions on the Patient File. These are **thin
 * callers**: they mount the shared `components/clinical/*` authoring forms (the
 * sole owner of validation/persistence/RLS/audit, doc 16 §5) with the current
 * patient preselected and, on a saved draft, hand the record id to the existing
 * clinical document preview surface. No business logic lives here.
 */
export function PatientFileClinicalActions({
  patientId,
  patientName,
  fileNumber,
  options,
  locale,
}: Props) {
  const t = useTranslations("patients");
  const router = useRouter();
  const [open, setOpen] = useState<ClinicalKind | null>(null);

  const patients = [{ id: patientId, fullName: patientName, fileNumber }];

  function handleSaved(recordId: string) {
    const kind = open;
    setOpen(null);
    if (!kind) return;
    const query = new URLSearchParams({ recordId, locale });
    router.push(`/documents/clinical/${kind}?${query.toString()}`);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setOpen("prescription")}
        >
          <Stethoscope className="h-3.5 w-3.5" />
          {t("newPrescription")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setOpen("lab-request")}
        >
          <FlaskConical className="h-3.5 w-3.5" />
          {t("newLabRequest")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5"
          onClick={() => setOpen("sick-leave")}
        >
          <FileText className="h-3.5 w-3.5" />
          {t("newSickLeave")}
        </Button>
      </div>

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {open === "prescription"
                ? t("newPrescription")
                : open === "lab-request"
                  ? t("newLabRequest")
                  : t("newSickLeave")}
            </DialogTitle>
            <DialogDescription>
              {t("clinicalActionSubtitle", { name: patientName })}
            </DialogDescription>
          </DialogHeader>

          {open === "prescription" && (
            <PrescriptionForm
              doctors={options.doctors}
              patients={patients}
              appointments={options.appointments}
              catalog={options.drugs}
              allowsExternalSubject={false}
              onSaved={handleSaved}
            />
          )}
          {open === "lab-request" && (
            <LabRequestForm
              doctors={options.doctors}
              patients={patients}
              appointments={options.appointments}
              catalog={options.labTests}
              allowsExternalSubject={false}
              onSaved={handleSaved}
            />
          )}
          {open === "sick-leave" && (
            <SickLeaveForm
              doctors={options.doctors}
              patients={patients}
              appointments={options.appointments}
              allowsExternalSubject={false}
              onSaved={handleSaved}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
