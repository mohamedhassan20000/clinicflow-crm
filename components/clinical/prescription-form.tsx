"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SingleDatePicker } from "@/components/ui/clinic-date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ClinicalSubjectFields, type ClinicalSubjectValue } from "@/components/clinical/clinical-subject-fields";
import type { ClinicalAppointmentOption, ClinicalDoctorOption, ClinicalPatientOption, DrugCatalogOption } from "@/components/clinical/types";
import { createPrescriptionDraft, updatePrescriptionDraft } from "@/actions/clinical/prescriptions";
import { prescriptionDraftSchema, type PrescriptionDraftInput } from "@/lib/validations/clinical";

type Props = {
  doctors: ClinicalDoctorOption[];
  patients: ClinicalPatientOption[];
  appointments?: ClinicalAppointmentOption[];
  catalog?: DrugCatalogOption[];
  initial?: PrescriptionDraftInput;
  recordId?: string;
  allowsExternalSubject?: boolean;
  onSaved?: (id: string) => void;
};

const emptyMedication = () => ({
  drug_catalog_id: null, drug_name: "", dose: null, frequency: null,
  duration: null, route: null, quantity: null, instructions: null,
  is_controlled_snapshot: false, sort_order: 0,
});

export function PrescriptionForm({ doctors, patients, appointments, catalog = [], initial, recordId, allowsExternalSubject = false, onSaved }: Props) {
  const t = useTranslations("clinical");
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState<PrescriptionDraftInput>(initial ?? {
    responsible_doctor_id: doctors[0]?.id ?? "",
    appointment_id: null,
    patient_id: patients[0]?.id ?? null,
    subject_full_name: null,
    subject_dob: null,
    subject_national_id: null,
    valid_until: null,
    notes: null,
    medications: [emptyMedication()],
  });
  const subject: ClinicalSubjectValue = {
    responsible_doctor_id: value.responsible_doctor_id,
    appointment_id: value.appointment_id ?? null,
    patient_id: value.patient_id ?? null,
    subject_full_name: value.subject_full_name ?? null,
    subject_dob: value.subject_dob ?? null,
    subject_national_id: value.subject_national_id ?? null,
  };
  const updateMedication = (index: number, patch: Partial<PrescriptionDraftInput["medications"][number]>) => {
    setValue((current) => ({ ...current, medications: current.medications.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) }));
  };

  function submit() {
    const normalized = { ...value, medications: value.medications.map((item, index) => ({ ...item, sort_order: index })) };
    const parsed = prescriptionDraftSchema.safeParse(normalized);
    if (!parsed.success) return toast.error(t("validationError"));
    startTransition(async () => {
      const result = recordId
        ? await updatePrescriptionDraft(recordId, parsed.data)
        : await createPrescriptionDraft(parsed.data);
      if (result.error) toast.error(result.error);
      else if (result.data) {
        toast.success(t("draftSaved"));
        onSaved?.(result.data.id);
      }
    });
  }

  return (
    <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="space-y-5">
      <ClinicalSubjectFields value={subject} onChange={(next) => setValue((current) => ({ ...current, ...next }))} doctors={doctors} patients={patients} appointments={appointments} allowsExternalSubject={allowsExternalSubject} disabled={pending} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5"><Label htmlFor="prescription-valid-until">{t("validUntil")}</Label><SingleDatePicker id="prescription-valid-until" label={t("validUntil")} value={value.valid_until ?? ""} onChange={(date) => setValue((current) => ({ ...current, valid_until: date || null }))} disabled={pending} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="prescription-notes">{t("notes")}</Label><Textarea id="prescription-notes" value={value.notes ?? ""} onChange={(event) => setValue((current) => ({ ...current, notes: event.target.value || null }))} disabled={pending} /></div>
      </div>
      <section className="space-y-3">
        <div className="flex items-center justify-between"><h3 className="font-medium">{t("medications")}</h3><Button type="button" variant="outline" size="sm" onClick={() => setValue((current) => ({ ...current, medications: [...current.medications, emptyMedication()] }))} disabled={pending}><Plus className="size-4" />{t("addMedication")}</Button></div>
        {value.medications.map((item, index) => {
          const doctor = doctors.find((entry) => entry.id === value.responsible_doctor_id);
          const available = catalog.filter((entry) => entry.departmentIds.length === 0 || (!!doctor?.departmentId && entry.departmentIds.includes(doctor.departmentId)));
          return <div key={item.id ?? index} className="grid gap-3 rounded-xl border p-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-3"><Label>{t("catalogDrug")}</Label><select className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={item.drug_catalog_id ?? ""} onChange={(event) => {
              const selected = available.find((entry) => entry.id === event.target.value);
              updateMedication(index, selected ? { drug_catalog_id: selected.id, drug_name: [selected.name, selected.form, selected.strength].filter(Boolean).join(" · "), is_controlled_snapshot: selected.isControlled } : { drug_catalog_id: null });
            }} disabled={pending}><option value="">{t("freeTextMedication")}</option>{available.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.strength ? ` · ${entry.strength}` : ""}</option>)}</select></div>
            <Field label={t("drugName")} value={item.drug_name} onChange={(drug_name) => updateMedication(index, { drug_name })} disabled={pending || Boolean(item.drug_catalog_id)} />
            <Field label={t("dose")} value={item.dose ?? ""} onChange={(dose) => updateMedication(index, { dose })} disabled={pending} />
            <Field label={t("frequency")} value={item.frequency ?? ""} onChange={(frequency) => updateMedication(index, { frequency })} disabled={pending} />
            <Field label={t("duration")} value={item.duration ?? ""} onChange={(duration) => updateMedication(index, { duration })} disabled={pending} />
            <Field label={t("route")} value={item.route ?? ""} onChange={(route) => updateMedication(index, { route })} disabled={pending} />
            <Field label={t("quantity")} value={item.quantity ?? ""} onChange={(quantity) => updateMedication(index, { quantity })} disabled={pending} />
            <div className="space-y-1.5 sm:col-span-3"><Label>{t("instructions")}</Label><Textarea value={item.instructions ?? ""} onChange={(event) => updateMedication(index, { instructions: event.target.value })} disabled={pending} /></div>
            {item.is_controlled_snapshot && <p className="text-sm font-medium text-destructive sm:col-span-2">{t("controlledMedicineWarning")}</p>}
            <Button type="button" variant="ghost" size="sm" className="justify-self-end text-destructive" onClick={() => setValue((current) => ({ ...current, medications: current.medications.filter((_, itemIndex) => itemIndex !== index) }))} disabled={pending || value.medications.length === 1}><Trash2 className="size-4" />{t("remove")}</Button>
          </div>;
        })}
      </section>
      <div className="flex justify-end"><Button type="submit" disabled={pending}>{pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{t("saveDraft")}</Button></div>
    </form>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <div className="space-y-1.5"><Label>{label}</Label><Input value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} /></div>;
}
