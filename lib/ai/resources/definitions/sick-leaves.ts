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
  id: field("id", "string", "identifier", "Sick leave id."),
  patient_id: field("patient_id", "string", "identifier", "Patient id."),
  subject_full_name: field("subject_full_name", "string", "clinical", "External subject name."),
  subject_dob: field("subject_dob", "date", "clinical", "External subject date of birth."),
  subject_national_id: field("subject_national_id", "string", "identifier", "External subject national id; explicit request only.", { maxListRows: 25 }),
  appointment_id: field("appointment_id", "string", "operational", "Related appointment id."),
  responsible_doctor_id: field("responsible_doctor_id", "string", "operational", "Responsible doctor id."),
  created_by: field("created_by", "string", "operational", "Creator profile id."),
  leave_start_date: field("leave_start_date", "date", "clinical", "Leave start date."),
  leave_end_date: field("leave_end_date", "date", "clinical", "Leave end date."),
  return_date: field("return_date", "date", "clinical", "Recorded return date."),
  recipient_organization: field("recipient_organization", "string", "clinical", "Recipient organization."),
  recipient_reference: field("recipient_reference", "string", "clinical", "Recipient reference."),
  restrictions: field("restrictions", "string", "clinical", "Recorded restrictions."),
  status: field("status", "string", "clinical", "Sick leave status."),
  finalized_at: field("finalized_at", "timestamp", "clinical", "Finalization time."),
  finalized_by: field("finalized_by", "string", "operational", "Finalizer profile id."),
  created_at: field("created_at", "timestamp", "internal", "Creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];

export const sickLeavesResource: ResourceDefinition = {
  id: "sick_leaves",
  table: "sick_leaves",
  // sick_leaves_select_scoped, created by
  // 20260802120000_p76a_clinical_authoring_foundations.sql, admits all clinic
  // roles and delegates doctor/assistant row scope to can_access_clinical_record.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: clinicalResourceFeature,
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Sick leave id."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in", "is"], "Patient id."),
    appointment_id: filter("appointment_id", uuidSchema, ["eq", "in"], "Appointment id."),
    responsible_doctor_id: filter("responsible_doctor_id", uuidSchema, ["eq", "in"], "Responsible doctor id."),
    status: filter("status", z.enum(["draft", "finalized", "void"]), ["eq", "in"], "Sick leave status."),
    leave_start_date: filter("leave_start_date", isoDateSchema, ["eq", "gt", "gte", "lt", "lte"], "Leave start date."),
    leave_end_date: filter("leave_end_date", isoDateSchema, ["eq", "gt", "gte", "lt", "lte"], "Leave end date."),
    created_at: filter("created_at", timestampSchema, ["eq", "gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["leave_start_date", "leave_end_date", "created_at", "updated_at", "status"],
  relations: {
    patient: patientRelation("patients!sick_leaves_patient_id_fkey"),
    responsible_doctor: profileRelation("responsible_doctor", "profiles!sick_leaves_responsible_doctor_id_fkey"),
    creator: profileRelation("creator", "profiles!sick_leaves_created_by_fkey"),
    finalizer: profileRelation("finalizer", "profiles!sick_leaves_finalized_by_fkey"),
    appointment: appointmentRelation("appointments!sick_leaves_appointment_id_fkey"),
  },
  // subject_national_id is intentionally explicit-only.
  defaultFields: ["id", "patient_id", "subject_full_name", "appointment_id", "responsible_doctor_id", "leave_start_date", "leave_end_date", "return_date", "recipient_organization", "restrictions", "status", "created_at"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Sick leaves", ar: "الإجازات المرضية" },
  description: {
    en: "Authorized sick-leave records, scoped by can_access_clinical_record RLS.",
    ar: "سجلات الإجازات المرضية المصرح بها والمقيدة بسياسة can_access_clinical_record.",
  },
};
