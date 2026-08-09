"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ClinicalSubjectFields, type ClinicalSubjectValue } from "@/components/clinical/clinical-subject-fields";
import type { ClinicalAppointmentOption, ClinicalDoctorOption, ClinicalPatientOption, LabTestCatalogOption } from "@/components/clinical/types";
import { createLabRequestDraft, updateLabRequestDraft } from "@/actions/clinical/lab-requests";
import { labRequestDraftSchema, type LabRequestDraftInput } from "@/lib/validations/clinical";

type Props = {
  doctors: ClinicalDoctorOption[];
  patients: ClinicalPatientOption[];
  appointments?: ClinicalAppointmentOption[];
  catalog?: LabTestCatalogOption[];
  initial?: LabRequestDraftInput;
  recordId?: string;
  allowsExternalSubject?: boolean;
  onSaved?: (id: string) => void;
};

const emptyTest = () => ({ lab_test_catalog_id: null, test_name: "", notes: null, sort_order: 0 });

export function LabRequestForm({ doctors, patients, appointments, catalog = [], initial, recordId, allowsExternalSubject = false, onSaved }: Props) {
  const t = useTranslations("clinical");
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<LabRequestDraftInput>(initial ?? {
    responsible_doctor_id: doctors[0]?.id ?? "", appointment_id: null,
    patient_id: patients[0]?.id ?? null, subject_full_name: null,
    subject_dob: null, subject_national_id: null, priority: "routine",
    laboratory_name: null, clinical_context: null, instructions: null,
    tests: [emptyTest()],
  });
  const subject: ClinicalSubjectValue = {
    responsible_doctor_id: value.responsible_doctor_id,
    appointment_id: value.appointment_id ?? null,
    patient_id: value.patient_id ?? null,
    subject_full_name: value.subject_full_name ?? null,
    subject_dob: value.subject_dob ?? null,
    subject_national_id: value.subject_national_id ?? null,
  };
  const updateTest = (index: number, patch: Partial<LabRequestDraftInput["tests"][number]>) => setValue((current) => ({ ...current, tests: current.tests.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));

  function submit() {
    const parsed = labRequestDraftSchema.safeParse({ ...value, tests: value.tests.map((item, index) => ({ ...item, sort_order: index })) });
    if (!parsed.success) return toast.error(t("validationError"));
    startTransition(async () => {
      const result = recordId ? await updateLabRequestDraft(recordId, parsed.data) : await createLabRequestDraft(parsed.data);
      if (result.error) toast.error(result.error);
      else if (result.data) { toast.success(t("draftSaved")); onSaved?.(result.data.id); }
    });
  }

  return <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="space-y-5">
    <ClinicalSubjectFields value={subject} onChange={(next) => setValue((current) => ({ ...current, ...next }))} doctors={doctors} patients={patients} appointments={appointments} allowsExternalSubject={allowsExternalSubject} disabled={pending} />
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5"><Label>{t("priority")}</Label><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={value.priority} onChange={(event) => setValue((current) => ({ ...current, priority: event.target.value as LabRequestDraftInput["priority"] }))}><option value="routine">{t("routine")}</option><option value="urgent">{t("urgent")}</option><option value="stat">{t("stat")}</option></select></div>
      <div className="space-y-1.5"><Label>{t("laboratoryName")}</Label><Input value={value.laboratory_name ?? ""} onChange={(event) => setValue((current) => ({ ...current, laboratory_name: event.target.value }))} /></div>
      <div className="space-y-1.5"><Label>{t("clinicalContext")}</Label><Textarea value={value.clinical_context ?? ""} onChange={(event) => setValue((current) => ({ ...current, clinical_context: event.target.value }))} /></div>
      <div className="space-y-1.5"><Label>{t("instructions")}</Label><Textarea value={value.instructions ?? ""} onChange={(event) => setValue((current) => ({ ...current, instructions: event.target.value }))} /></div>
    </div>
    <section className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-medium">{t("requestedTests")}</h3><Button type="button" variant="outline" size="sm" onClick={() => setValue((current) => ({ ...current, tests: [...current.tests, emptyTest()] }))}><Plus className="size-4" />{t("addTest")}</Button></div>
      {value.tests.map((item, index) => {
        const doctor = doctors.find((entry) => entry.id === value.responsible_doctor_id);
        const available = catalog.filter((entry) => entry.departmentIds.length === 0 || (!!doctor?.departmentId && entry.departmentIds.includes(doctor.departmentId)));
        return <div key={item.id ?? index} className="grid gap-3 rounded-xl border p-4 sm:grid-cols-[1fr_1fr_auto]">
          <div className="space-y-1.5"><Label>{t("catalogTest")}</Label><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={item.lab_test_catalog_id ?? ""} onChange={(event) => { const selected = available.find((entry) => entry.id === event.target.value); updateTest(index, selected ? { lab_test_catalog_id: selected.id, test_name: selected.name } : { lab_test_catalog_id: null }); }}><option value="">{t("freeTextTest")}</option>{available.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></div>
          <div className="space-y-1.5"><Label>{t("testName")}</Label><Input value={item.test_name} onChange={(event) => updateTest(index, { test_name: event.target.value })} disabled={Boolean(item.lab_test_catalog_id)} /></div>
          <Button type="button" variant="ghost" size="icon" className="self-end text-destructive" aria-label={t("remove")} onClick={() => setValue((current) => ({ ...current, tests: current.tests.filter((_, itemIndex) => itemIndex !== index) }))} disabled={value.tests.length === 1}><Trash2 className="size-4" /></Button>
          <div className="space-y-1.5 sm:col-span-3"><Label>{t("notes")}</Label><Textarea value={item.notes ?? ""} onChange={(event) => updateTest(index, { notes: event.target.value })} /></div>
        </div>;
      })}
    </section>
    <div className="flex justify-end"><Button type="submit" disabled={pending}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{t("saveDraft")}</Button></div>
  </form>;
}
