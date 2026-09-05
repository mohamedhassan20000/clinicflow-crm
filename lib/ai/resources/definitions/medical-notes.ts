import "server-only";

import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import {
  clinicTimestampFilter,
  filter,
  shortTextSchema,
  uuidSchema,
} from "@/lib/ai/resources/filters";
import { MEDICAL_NOTE_READ_ROLES } from "@/lib/patients/read-permissions";
import type { ResourceDefinition } from "@/lib/ai/resources/types";
import {
  appointmentRelation,
  clinicalResourceFeature,
  patientRelation,
  profileRelation,
} from "@/lib/ai/resources/definitions/clinical-shared";

const fields = {
  id: field("id", "string", "identifier", "Medical note id."),
  patient_id: field("patient_id", "string", "identifier", "Patient id."),
  doctor_id: field("doctor_id", "string", "operational", "Authoring doctor id."),
  appointment_id: field("appointment_id", "string", "operational", "Related appointment id."),
  created_by: field("created_by", "string", "operational", "Creator profile id."),
  note: field("note", "string", "clinical", "Medical note text."),
  created_at: field("created_at", "timestamp", "internal", "Note creation time."),
} satisfies ResourceDefinition["fields"];

export const medicalNotesResource: ResourceDefinition = {
  id: "medical_notes",
  table: "medical_notes",
  // medical_notes_select_role_scoped, last changed by
  // 20260519006000_medical_notes_reception_read.sql, admits admin and
  // receptionist clinic-wide plus scoped doctors. Phase 2 deliberately leaves
  // manager and assistant excluded to match the application and attachment path.
  roles: MEDICAL_NOTE_READ_ROLES,
  requiredFeatures: clinicalResourceFeature,
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Medical note id."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in"], "Patient id."),
    doctor_id: filter("doctor_id", uuidSchema, ["eq", "in"], "Doctor id."),
    appointment_id: filter("appointment_id", uuidSchema, ["eq", "in", "is"], "Appointment id."),
    created_by: filter("created_by", uuidSchema, ["eq", "in", "is"], "Creator profile id."),
    // P7-02: `search_patient_visits` took a clinic-local date window and
    // resolved it through `clinicDateRangeToUtc`; the generic path keeps that.
    created_at: clinicTimestampFilter(
      "created_at",
      ["eq", "gt", "gte", "lt", "lte"],
      "Creation time.",
    ),
    // Phase 7 supersession parity: `search_patient_visits` matched note text
    // with a server-escaped `ilike`. The compiler owns the wildcard shape and
    // escapes LIKE metacharacters, so this is a substring match over a column
    // the same caller may already read in full — it widens no row scope.
    note: filter("note", shortTextSchema, ["ilike"], "Substring match within the note text."),
  },
  sorts: ["created_at", "id"],
  relations: {
    patient: patientRelation("patients!medical_notes_patient_id_fkey"),
    doctor: profileRelation("doctor", "profiles!medical_notes_doctor_id_fkey"),
    creator: profileRelation("creator", "profiles!medical_notes_created_by_fkey"),
    appointment: appointmentRelation("appointments!medical_notes_appointment_id_fkey"),
  },
  defaultFields: ["id", "patient_id", "doctor_id", "appointment_id", "note", "created_at"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Medical notes", ar: "الملاحظات الطبية" },
  description: {
    en: "Authorized medical notes, including narrative text, scoped by existing RLS.",
    ar: "الملاحظات الطبية المصرح بها، بما فيها النص السريري، والمقيدة بسياسات الوصول الحالية.",
  },
  baseFilters: [{ column: "deleted_at", operator: "is", value: null }],
  // This legacy table derives its tenant from patients and has no clinic_id.
  tenantScope: {
    select: "__tenant_patient:patients!medical_notes_patient_id_fkey!inner(id)",
    column: "__tenant_patient.clinic_id",
    resultAlias: "__tenant_patient",
  },
};
