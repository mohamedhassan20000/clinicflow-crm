import "server-only";

import { z } from "zod";
import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { filter, timestampSchema, uuidSchema } from "@/lib/ai/resources/filters";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import type { ResourceDefinition } from "@/lib/ai/resources/types";
import {
  appointmentRelation,
  clinicalResourceFeature,
  patientRelation,
  profileRelation,
} from "@/lib/ai/resources/definitions/clinical-shared";

const fields = {
  id: field("id", "string", "identifier", "Lab request id."),
  patient_id: field("patient_id", "string", "identifier", "Patient id."),
  subject_full_name: field("subject_full_name", "string", "clinical", "External subject name."),
  subject_dob: field("subject_dob", "date", "clinical", "External subject date of birth."),
  subject_national_id: field("subject_national_id", "string", "identifier", "External subject national id; explicit request only.", { maxListRows: 25 }),
  appointment_id: field("appointment_id", "string", "operational", "Related appointment id."),
  responsible_doctor_id: field("responsible_doctor_id", "string", "operational", "Responsible doctor id."),
  created_by: field("created_by", "string", "operational", "Creator profile id."),
  priority: field("priority", "string", "clinical", "Request priority."),
  laboratory_name: field("laboratory_name", "string", "clinical", "Destination laboratory."),
  clinical_context: field("clinical_context", "string", "clinical", "Recorded clinical context."),
  instructions: field("instructions", "string", "clinical", "Recorded laboratory instructions."),
  status: field("status", "string", "clinical", "Request status."),
  finalized_at: field("finalized_at", "timestamp", "clinical", "Finalization time."),
  finalized_by: field("finalized_by", "string", "operational", "Finalizer profile id."),
  created_at: field("created_at", "timestamp", "internal", "Creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];

const testFields = {
  id: field("id", "string", "identifier", "Lab test row id."),
  test_name: field("test_name", "string", "clinical", "Requested test name."),
  notes: field("notes", "string", "clinical", "Recorded test notes."),
  sort_order: field("sort_order", "number", "internal", "Test display order."),
};

export const labRequestsResource: ResourceDefinition = {
  id: "lab_requests",
  table: "lab_requests",
  // lab_requests_select_scoped, created by
  // 20260802120000_p76a_clinical_authoring_foundations.sql, admits all clinic
  // roles and delegates doctor/assistant row scope to can_access_clinical_record.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: clinicalResourceFeature,
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Lab request id."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in", "is"], "Patient id."),
    appointment_id: filter("appointment_id", uuidSchema, ["eq", "in", "is"], "Appointment id."),
    responsible_doctor_id: filter("responsible_doctor_id", uuidSchema, ["eq", "in"], "Responsible doctor id."),
    priority: filter("priority", z.enum(["routine", "urgent", "stat"]), ["eq", "in"], "Request priority."),
    status: filter("status", z.enum(["draft", "finalized", "void"]), ["eq", "in"], "Request status."),
    created_at: filter("created_at", timestampSchema, ["eq", "gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["created_at", "updated_at", "priority", "status"],
  relations: {
    patient: patientRelation("patients!lab_requests_patient_id_fkey"),
    responsible_doctor: profileRelation("responsible_doctor", "profiles!lab_requests_responsible_doctor_id_fkey"),
    creator: profileRelation("creator", "profiles!lab_requests_created_by_fkey"),
    finalizer: profileRelation("finalizer", "profiles!lab_requests_finalized_by_fkey"),
    appointment: appointmentRelation("appointments!lab_requests_appointment_id_fkey"),
    tests: {
      alias: "tests",
      select: "lab_request_tests!lab_request_tests_lab_request_id_fkey",
      fields: testFields,
      fieldPolicy: declaredFieldPolicy(testFields),
      defaultFields: ["id", "test_name", "notes", "sort_order"],
      description: "Tests recorded on the laboratory request.",
    },
  },
  // subject_national_id is intentionally explicit-only.
  defaultFields: ["id", "patient_id", "subject_full_name", "appointment_id", "responsible_doctor_id", "priority", "laboratory_name", "clinical_context", "instructions", "status", "created_at"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Lab requests", ar: "طلبات المختبر" },
  description: {
    en: "Authorized laboratory requests and requested tests, scoped by can_access_clinical_record RLS.",
    ar: "طلبات المختبر والفحوصات المصرح بها والمقيدة بسياسة can_access_clinical_record.",
  },
};
