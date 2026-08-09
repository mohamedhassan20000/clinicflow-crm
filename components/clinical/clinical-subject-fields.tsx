"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { SingleDatePicker } from "@/components/ui/clinic-date-picker";
import { Label } from "@/components/ui/label";
import type {
  ClinicalAppointmentOption,
  ClinicalDoctorOption,
  ClinicalPatientOption,
} from "@/components/clinical/types";

export type ClinicalSubjectValue = {
  responsible_doctor_id: string;
  appointment_id: string | null;
  patient_id: string | null;
  subject_full_name: string | null;
  subject_dob: string | null;
  subject_national_id: string | null;
};

type Props = {
  value: ClinicalSubjectValue;
  onChange: (value: ClinicalSubjectValue) => void;
  doctors: ClinicalDoctorOption[];
  patients: ClinicalPatientOption[];
  appointments?: ClinicalAppointmentOption[];
  allowsExternalSubject?: boolean;
  appointmentRequired?: boolean;
  disabled?: boolean;
};

export function ClinicalSubjectFields({
  value,
  onChange,
  doctors,
  patients,
  appointments = [],
  allowsExternalSubject = false,
  appointmentRequired = false,
  disabled,
}: Props) {
  const t = useTranslations("clinical");
  const isExternal = allowsExternalSubject && !value.patient_id;
  const update = (patch: Partial<ClinicalSubjectValue>) => onChange({ ...value, ...patch });
  const availableAppointments = appointments.filter(
    (appointment) => !value.patient_id || appointment.patientId === value.patient_id,
  );

  return (
    <fieldset className="grid gap-4 rounded-xl border p-4 sm:grid-cols-2" disabled={disabled}>
      <legend className="px-2 text-sm font-medium">{t("subjectAndResponsibility")}</legend>
      <div className="space-y-1.5">
        <Label htmlFor="clinical-responsible-doctor">{t("responsibleDoctor")}</Label>
        <select id="clinical-responsible-doctor" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={value.responsible_doctor_id} onChange={(event) => update({ responsible_doctor_id: event.target.value })} required>
          <option value="">{t("selectDoctor")}</option>
          {doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.fullName}</option>)}
        </select>
      </div>
      {allowsExternalSubject && (
        <div className="space-y-1.5">
          <Label htmlFor="clinical-subject-kind">{t("subjectType")}</Label>
          <select id="clinical-subject-kind" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={isExternal ? "external" : "patient"} onChange={(event) => {
            if (event.target.value === "external") update({ patient_id: null, appointment_id: null, subject_full_name: "" });
            else update({ patient_id: "", subject_full_name: null, subject_dob: null, subject_national_id: null });
          }}>
            <option value="patient">{t("registeredPatient")}</option>
            <option value="external">{t("externalSubject")}</option>
          </select>
        </div>
      )}
      {!isExternal ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="clinical-patient">{t("patient")}</Label>
          <select id="clinical-patient" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={value.patient_id ?? ""} onChange={(event) => update({ patient_id: event.target.value, appointment_id: null })} required>
            <option value="">{t("selectPatient")}</option>
            {patients.map((patient) => <option key={patient.id} value={patient.id}>{patient.fullName}{patient.fileNumber ? ` · ${patient.fileNumber}` : ""}</option>)}
          </select>
        </div>
      ) : (
        <>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="clinical-external-name">{t("externalFullName")}</Label>
            <Input id="clinical-external-name" value={value.subject_full_name ?? ""} onChange={(event) => update({ subject_full_name: event.target.value })} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="clinical-external-dob">{t("dateOfBirth")}</Label>
            <SingleDatePicker id="clinical-external-dob" label={t("dateOfBirth")} value={value.subject_dob ?? ""} onChange={(date) => update({ subject_dob: date || null })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="clinical-external-national-id">{t("nationalId")}</Label>
            <Input id="clinical-external-national-id" value={value.subject_national_id ?? ""} onChange={(event) => update({ subject_national_id: event.target.value || null })} />
          </div>
        </>
      )}
      {!isExternal && (appointmentRequired || availableAppointments.length > 0) && (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="clinical-appointment">{t("appointment")}</Label>
          <select id="clinical-appointment" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={value.appointment_id ?? ""} onChange={(event) => update({ appointment_id: event.target.value || null })} required={appointmentRequired}>
            <option value="">{appointmentRequired ? t("selectAppointment") : t("noAppointment")}</option>
            {availableAppointments.map((appointment) => <option key={appointment.id} value={appointment.id}>{appointment.label}</option>)}
          </select>
        </div>
      )}
    </fieldset>
  );
}
