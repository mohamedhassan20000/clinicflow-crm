import "server-only";

import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { booleanSchema, filter, timestampSchema, uuidSchema } from "@/lib/ai/resources/filters";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import type { ResourceDefinition } from "@/lib/ai/resources/types";
import {
  clinicalResourceFeature,
  namedRelation,
  patientRelation,
  profileRelation,
} from "@/lib/ai/resources/definitions/clinical-shared";

const fields = {
  id: field("id", "string", "identifier", "Patient package id."),
  patient_id: field("patient_id", "string", "identifier", "Patient id."),
  service_id: field("service_id", "string", "operational", "Service id."),
  department_id: field("department_id", "string", "operational", "Department id."),
  name: field("name", "string", "clinical", "Package name."),
  total_sessions: field("total_sessions", "number", "clinical", "Total package sessions."),
  used_sessions: field("used_sessions", "number", "clinical", "Used package sessions."),
  price_per_session: field("price_per_session", "number", "clinical", "Recorded price per session."),
  notes: field("notes", "string", "clinical", "Package notes."),
  is_active: field("is_active", "boolean", "operational", "Whether the package is active."),
  created_by: field("created_by", "string", "operational", "Creator profile id."),
  created_at: field("created_at", "timestamp", "internal", "Creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];

export const patientPackagesResource: ResourceDefinition = {
  id: "patient_packages",
  table: "patient_packages",
  // clinic_members_read_packages, last changed by
  // 20260813140000_ai_assistant_phase2_clinical_read_parity.sql, admits all
  // clinic roles while matching doctor/assistant rows to active-patient scope.
  // ai.read_clinical is intentional because package names, notes, and session
  // usage are treatment-plan PHI even though booking also consumes the rows.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: clinicalResourceFeature,
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Patient package id."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in"], "Patient id."),
    service_id: filter("service_id", uuidSchema, ["eq", "in", "is"], "Service id."),
    department_id: filter("department_id", uuidSchema, ["eq", "in", "is"], "Department id."),
    is_active: filter("is_active", booleanSchema, ["eq"], "Active state."),
    created_by: filter("created_by", uuidSchema, ["eq", "in", "is"], "Creator profile id."),
    created_at: filter("created_at", timestampSchema, ["eq", "gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["created_at", "updated_at", "name", "used_sessions", "total_sessions"],
  relations: {
    patient: patientRelation("patients!patient_packages_patient_id_fkey"),
    service: namedRelation("service", "services!patient_packages_service_id_fkey"),
    department: namedRelation("department", "departments!patient_packages_department_id_fkey"),
    creator: profileRelation("creator", "profiles!patient_packages_created_by_fkey"),
  },
  defaultFields: ["id", "patient_id", "service_id", "department_id", "name", "total_sessions", "used_sessions", "price_per_session", "notes", "is_active", "created_at"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Patient packages", ar: "باقات المرضى" },
  description: {
    en: "Authorized patient treatment-package records under existing package RLS.",
    ar: "سجلات باقات علاج المرضى المصرح بها وفق سياسات الباقات الحالية.",
  },
};
