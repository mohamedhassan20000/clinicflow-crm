"use client";

import { useState, useTransition } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DateRangePicker, SingleDatePicker } from "@/components/ui/clinic-date-picker";
import { ClinicalSubjectFields, type ClinicalSubjectValue } from "@/components/clinical/clinical-subject-fields";
import type { ClinicalAppointmentOption, ClinicalDoctorOption, ClinicalPatientOption } from "@/components/clinical/types";
import { createSickLeaveDraft, updateSickLeaveDraft } from "@/actions/clinical/sick-leaves";
import { sickLeaveDraftSchema, type SickLeaveDraftInput } from "@/lib/validations/clinical";

type Props = {
  doctors: ClinicalDoctorOption[];
  patients: ClinicalPatientOption[];
  appointments: ClinicalAppointmentOption[];
  initial?: SickLeaveDraftInput;
  recordId?: string;
  allowsExternalSubject?: boolean;
  onSaved?: (id: string) => void;
};

export function SickLeaveForm({ doctors, patients, appointments, initial, recordId, allowsExternalSubject = false, onSaved }: Props) {
  const t = useTranslations("clinical");
  const [pending, startTransition] = useTransition();
  const today = new Date().toISOString().slice(0, 10);
  const [value, setValue] = useState<SickLeaveDraftInput>(initial ?? {
    responsible_doctor_id: doctors[0]?.id ?? "", appointment_id: null,
    patient_id: patients[0]?.id ?? null, subject_full_name: null,
    subject_dob: null, subject_national_id: null,
    leave_start_date: today, leave_end_date: today,
    recipient_organization: null, recipient_reference: null,
    restrictions: null, return_date: null,
  });
  const subject: ClinicalSubjectValue = {
    responsible_doctor_id: value.responsible_doctor_id,
    appointment_id: value.appointment_id ?? null,
    patient_id: value.patient_id ?? null,
    subject_full_name: value.subject_full_name ?? null,
    subject_dob: value.subject_dob ?? null,
    subject_national_id: value.subject_national_id ?? null,
  };

  function submit() {
    const parsed = sickLeaveDraftSchema.safeParse(value);
    if (!parsed.success) return toast.error(t("validationError"));
    startTransition(async () => {
      const result = recordId ? await updateSickLeaveDraft(recordId, parsed.data) : await createSickLeaveDraft(parsed.data);
      if (result.error) toast.error(result.error);
      else if (result.data) { toast.success(t("draftSaved")); onSaved?.(result.data.id); }
    });
  }
  const field = (key: "recipient_organization" | "recipient_reference", label: string) => <div className="space-y-1.5"><Label>{label}</Label><Input value={value[key] ?? ""} onChange={(event) => setValue((current) => ({ ...current, [key]: event.target.value || null }))} disabled={pending} /></div>;

  return <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="space-y-5">
    <ClinicalSubjectFields value={subject} onChange={(next) => setValue((current) => ({ ...current, ...next, appointment_id: next.appointment_id || null }))} doctors={doctors} patients={patients} appointments={appointments} allowsExternalSubject={allowsExternalSubject} appointmentRequired disabled={pending} />
    <div className="grid gap-4 sm:grid-cols-2">
      <DateRangePicker
        from={value.leave_start_date}
        to={value.leave_end_date}
        labels={{ from: t("leaveStartDate"), to: t("leaveEndDate") }}
        onFromChange={(leave_start_date) => setValue((current) => ({ ...current, leave_start_date }))}
        onToChange={(leave_end_date) => setValue((current) => ({ ...current, leave_end_date }))}
        disabled={pending}
        className="sm:col-span-2"
      />
      <div className="space-y-1.5"><Label>{t("returnDate")}</Label><SingleDatePicker label={t("returnDate")} value={value.return_date ?? ""} onChange={(return_date) => setValue((current) => ({ ...current, return_date: return_date || null }))} disabled={pending} /></div>
      {field("recipient_organization", t("recipientOrganization"))}{field("recipient_reference", t("recipientReference"))}
      <div className="space-y-1.5 sm:col-span-2"><Label>{t("restrictions")}</Label><Textarea value={value.restrictions ?? ""} onChange={(event) => setValue((current) => ({ ...current, restrictions: event.target.value }))} /></div>
    </div>
    <div className="flex justify-end"><Button type="submit" disabled={pending}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{t("saveDraft")}</Button></div>
  </form>;
}
