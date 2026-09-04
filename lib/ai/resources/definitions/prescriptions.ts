import "server-only";

import { z } from "zod";
import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { filter, isoDateSchema, timestampSchema, uuidSchema } from "@/lib/ai/resources/filters";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import type { ResourceDefinition } from "@/lib/ai/resources/types";
import {
  appointmentRelation,
  clinicalResourceFeature,
  patientRelation,
  profileRelation,
} from "@/lib/ai/resources/definitions/clinical-shared";

const fields = {
  id: field("id", "string", "identifier", "Prescription id."),
  patient_id: field("patient_id", "string", "identifier", "Patient id."),
  subject_full_name: field("subject_full_name", "string", "clinical", "External subject name."),
  subject_dob: field("subject_dob", "date", "clinical", "External subject date of birth."),
  subject_national_id: field("subject_national_id", "string", "identifier", "External subject national id; explicit request only.", { maxListRows: 25 }),
  appointment_id: field("appointment_id", "string", "operational", "Related appointment id."),
  responsible_doctor_id: field("responsible_doctor_id", "string", "operational", "Responsible doctor id."),
  created_by: field("created_by", "string", "operational", "Creator profile id."),
  status: field("status", "string", "clinical", "Prescription status."),
  valid_until: field("valid_until", "date", "clinical", "Prescription validity date."),
  notes: field("notes", "string", "clinical", "Prescription notes."),
  finalized_at: field("finalized_at", "timestamp", "clinical", "Finalization time."),
  finalized_by: field("finalized_by", "string", "operational", "Finalizer profile id."),
  created_at: field("created_at", "timestamp", "internal", "Creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];

const medicationFields = {
  id: field("id", "string", "identifier", "Medication row id."),
  drug_name: field("drug_name", "string", "clinical", "Medication name recorded on the prescription."),
  dose: field("dose", "string", "clinical", "Recorded dose."),
  frequency: field("frequency", "string", "clinical", "Recorded frequency."),
  duration: field("duration", "string", "clinical", "Recorded duration."),
  route: field("route", "string", "clinical", "Recorded administration route."),
  quantity: field("quantity", "string", "clinical", "Recorded quantity."),
  instructions: field("instructions", "string", "clinical", "Recorded medication instructions."),
  is_controlled_snapshot: field("is_controlled_snapshot", "boolean", "clinical", "Controlled-drug snapshot."),
  sort_order: field("sort_order", "number", "internal", "Medication display order."),
};

export const prescriptionsResource: ResourceDefinition = {
  id: "prescriptions",
  table: "prescriptions",
  // prescriptions_select_scoped, created by
  // 20260802120000_p76a_clinical_authoring_foundations.sql, admits all clinic
  // roles and delegates doctor/assistant row scope to can_access_clinical_record.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: clinicalResourceFeature,
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Prescription id."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in", "is"], "Patient id."),
    appointment_id: filter("appointment_id", uuidSchema, ["eq", "in", "is"], "Appointment id."),
    responsible_doctor_id: filter("responsible_doctor_id", uuidSchema, ["eq", "in"], "Responsible doctor id."),
    status: filter("status", z.enum(["draft", "finalized", "void"]), ["eq", "in"], "Prescription status."),
    valid_until: filter("valid_until", isoDateSchema, ["eq", "gt", "gte", "lt", "lte", "is"], "Validity date."),
    created_at: filter("created_at", timestampSchema, ["eq", "gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["created_at", "updated_at", "valid_until", "status"],
  relations: {
    patient: patientRelation("patients!prescriptions_patient_id_fkey"),
    responsible_doctor: profileRelation("responsible_doctor", "profiles!prescriptions_responsible_doctor_id_fkey"),
    creator: profileRelation("creator", "profiles!prescriptions_created_by_fkey"),
    finalizer: profileRelation("finalizer", "profiles!prescriptions_finalized_by_fkey"),
    appointment: appointmentRelation("appointments!prescriptions_appointment_id_fkey"),
    medications: {
      alias: "medications",
      select: "prescription_medications!prescription_medications_prescription_id_fkey",
      fields: medicationFields,
      fieldPolicy: declaredFieldPolicy(medicationFields),
      defaultFields: ["id", "drug_name", "dose", "frequency", "duration", "route", "quantity", "instructions", "sort_order"],
      description: "Medication lines recorded on the prescription.",
    },
  },
  // subject_national_id is intentionally explicit-only.
  defaultFields: ["id", "patient_id", "subject_full_name", "appointment_id", "responsible_doctor_id", "status", "valid_until", "notes", "created_at"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Prescriptions", ar: "الوصفات الطبية" },
  description: {
    en: "Authorized prescription records and medication lines, scoped by can_access_clinical_record RLS.",
    ar: "سجلات الوصفات والأدوية المصرح بها والمقيدة بسياسة can_access_clinical_record.",
  },
};
