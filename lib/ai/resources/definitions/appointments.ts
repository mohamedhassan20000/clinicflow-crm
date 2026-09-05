import "server-only";

import { z } from "zod";
import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import {
  clinicTimestampFilter,
  filter,
  resolveDepartmentResourceFilter,
  resolveDoctorResourceFilter,
  shortTextSchema,
  uuidSchema,
} from "@/lib/ai/resources/filters";
import type { ResourceDefinition } from "@/lib/ai/resources/types";

const fields = {
  id: field("id", "string", "identifier", "Appointment id."),
  patient_id: field("patient_id", "string", "identifier", "Patient id."),
  doctor_id: field("doctor_id", "string", "operational", "Doctor id."),
  department_id: field("department_id", "string", "operational", "Department id."),
  service_id: field("service_id", "string", "operational", "Service id."),
  insurance_provider_id: field("insurance_provider_id", "string", "operational", "Insurance provider id."),
  scheduled_at: field("scheduled_at", "timestamp", "operational", "Scheduled start time."),
  duration_minutes: field("duration_minutes", "number", "operational", "Appointment duration."),
  status: field("status", "string", "operational", "Appointment status."),
  cancellation_reason: field("cancellation_reason", "string", "operational", "Cancellation reason."),
  no_show_reason: field("no_show_reason", "string", "operational", "No-show reason."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];

const named = {
  id: field("id", "string", "identifier", "Related id."),
  name: field("name", "string", "operational", "Related name."),
};
const person = {
  id: field("id", "string", "identifier", "Related id."),
  full_name: field("full_name", "string", "operational", "Full name."),
};
const patient = {
  ...person,
  file_number: field("file_number", "string", "identifier", "Patient file number."),
};

export const appointmentsResource: ResourceDefinition = {
  id: "appointments",
  table: "appointments",
  // App role source of truth; appointments_select_role_scoped applies each
  // role's row scope, including the supervised-doctor union for assistants.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Appointment id."),
    patient_id: filter("patient_id", uuidSchema, ["eq", "in"], "Patient id."),
    doctor: filter("doctor_id", shortTextSchema, ["eq"], "Doctor name or id.", resolveDoctorResourceFilter),
    doctor_id: filter("doctor_id", uuidSchema, ["eq", "in"], "Doctor id."),
    department: filter("department_id", shortTextSchema, ["eq"], "Department name or id.", resolveDepartmentResourceFilter),
    department_id: filter("department_id", uuidSchema, ["eq", "in", "is"], "Department id."),
    service_id: filter("service_id", uuidSchema, ["eq", "in", "is"], "Service id."),
    status: filter(
      "status",
      z.enum(["pending", "confirmed", "arrived", "in_session", "completed", "cancelled", "no_show", "replaced"]),
      ["eq", "in"],
      "Appointment status.",
    ),
    // P7-02: carries the clinic-local date semantics `list_appointments`,
    // `list_doctor_appointments` and `search_patient_visits` resolved
    // server-side before they were superseded.
    scheduled_at: clinicTimestampFilter(
      "scheduled_at",
      ["eq", "gt", "gte", "lt", "lte"],
      "Scheduled time.",
    ),
  },
  sorts: ["scheduled_at", "status", "created_at", "updated_at"],
  relations: {
    patient: {
      alias: "patient",
      select: "patients!appointments_patient_id_fkey",
      fields: patient,
      fieldPolicy: declaredFieldPolicy(patient),
      defaultFields: ["id", "full_name", "file_number"],
      description: "Appointment patient.",
    },
    doctor: {
      alias: "doctor",
      select: "profiles!appointments_doctor_id_fkey",
      fields: person,
      fieldPolicy: declaredFieldPolicy(person),
      defaultFields: ["id", "full_name"],
      description: "Appointment doctor.",
    },
    department: {
      alias: "department",
      select: "departments!appointments_department_id_fkey",
      fields: named,
      fieldPolicy: declaredFieldPolicy(named),
      defaultFields: ["id", "name"],
      description: "Appointment department.",
    },
    service: {
      alias: "service",
      select: "services!appointments_service_id_fkey",
      fields: named,
      fieldPolicy: declaredFieldPolicy(named),
      defaultFields: ["id", "name"],
      description: "Appointment service.",
    },
  },
  defaultFields: ["id", "patient_id", "doctor_id", "department_id", "scheduled_at", "duration_minutes", "status"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Appointments", ar: "المواعيد" },
  description: {
    en: "Authorized appointment records, scoped by ClinicFlow RLS.",
    ar: "سجلات المواعيد المصرح بها والمقيدة بسياسات ClinicFlow.",
  },
  baseFilters: [{ column: "deleted_at", operator: "is", value: null }],
};
