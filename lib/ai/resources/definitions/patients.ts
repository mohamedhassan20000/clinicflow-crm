import "server-only";

import { z } from "zod";
import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import {
  booleanSchema,
  filter,
  isoDateSchema,
  resolveDepartmentResourceFilter,
  resolveDoctorResourceFilter,
  shortTextSchema,
  timestampSchema,
  uuidSchema,
} from "@/lib/ai/resources/filters";
import type { ResourceDefinition } from "@/lib/ai/resources/types";

const fields = {
  id: field("id", "string", "identifier", "Patient record id."),
  full_name: field("full_name", "string", "operational", "Patient full name."),
  file_number: field("file_number", "string", "identifier", "Clinic file number."),
  phone: field("phone", "string", "contact", "Patient phone number."),
  email: field("email", "string", "contact", "Patient email address."),
  date_of_birth: field("date_of_birth", "date", "clinical", "Patient date of birth."),
  blood_type: field("blood_type", "string", "clinical", "Patient blood type."),
  national_id: field(
    "national_id",
    "string",
    "identifier",
    "National identifier. Explicit request only and never for lists above 25 rows.",
    { maxListRows: 25 },
  ),
  department_id: field("department_id", "string", "operational", "Assigned department id."),
  assigned_doctor_id: field(
    "assigned_doctor_id",
    "string",
    "operational",
    "Assigned doctor id.",
  ),
  insurance_provider_id: field(
    "insurance_provider_id",
    "string",
    "operational",
    "Insurance provider id.",
  ),
  is_archived: field("is_archived", "boolean", "operational", "Whether the patient is archived."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];

const relationFields = {
  id: field("id", "string", "identifier", "Related record id."),
  name: field("name", "string", "operational", "Related record name."),
};

const doctorRelationFields = {
  id: field("id", "string", "identifier", "Doctor id."),
  full_name: field("full_name", "string", "operational", "Doctor full name."),
};

export const patientsResource: ResourceDefinition = {
  id: "patients",
  table: "patients",
  // App role source of truth; patients_select_role_scoped independently narrows
  // doctor and assistant rows while admitting clinic-wide operational roles.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Patient id."),
    full_name: filter("full_name", shortTextSchema, ["eq", "ilike"], "Patient name."),
    file_number: filter("file_number", shortTextSchema, ["eq", "ilike"], "File number."),
    department: filter(
      "department_id",
      shortTextSchema,
      ["eq"],
      "Department name or id.",
      resolveDepartmentResourceFilter,
    ),
    // `is` supports the "patients with no department yet" question and the null
    // bucket of a department distribution. It narrows nothing: the same rows are
    // already reachable without the filter.
    department_id: filter("department_id", uuidSchema, ["eq", "in", "is"], "Department id."),
    doctor: filter(
      "assigned_doctor_id",
      shortTextSchema,
      ["eq"],
      "Assigned doctor name or id.",
      resolveDoctorResourceFilter,
    ),
    assigned_doctor_id: filter(
      "assigned_doctor_id",
      uuidSchema,
      ["eq", "in", "is"],
      "Assigned doctor id.",
    ),
    insurance_provider_id: filter(
      "insurance_provider_id",
      uuidSchema,
      ["eq", "in", "is"],
      "Insurance provider id.",
    ),
    is_archived: filter("is_archived", booleanSchema, ["eq"], "Archive state."),
    date_of_birth: filter("date_of_birth", isoDateSchema, ["eq", "gt", "gte", "lt", "lte"], "Date of birth."),
    blood_type: filter(
      "blood_type",
      z.enum(["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"]),
      ["eq", "in", "is"],
      "Blood type.",
    ),
    created_at: filter("created_at", timestampSchema, ["gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["full_name", "file_number", "date_of_birth", "created_at", "updated_at"],
  relations: {
    department: {
      alias: "department",
      select: "departments!patients_department_id_fkey",
      fields: relationFields,
      fieldPolicy: declaredFieldPolicy(relationFields),
      defaultFields: ["id", "name"],
      description: "Assigned department.",
    },
    assigned_doctor: {
      alias: "assigned_doctor",
      select: "profiles!patients_assigned_doctor_id_fkey",
      fields: doctorRelationFields,
      fieldPolicy: declaredFieldPolicy(doctorRelationFields),
      defaultFields: ["id", "full_name"],
      description: "Assigned doctor.",
    },
    insurance_provider: {
      alias: "insurance_provider",
      select: "insurance_providers!patients_insurance_provider_id_fkey",
      fields: relationFields,
      fieldPolicy: declaredFieldPolicy(relationFields),
      defaultFields: ["id", "name"],
      description: "Insurance provider.",
    },
  },
  // `national_id` is intentionally absent. It is explicit-only (§19 decision 2).
  defaultFields: ["id", "full_name", "file_number", "department_id", "assigned_doctor_id"],
  rowCap: 200,
  // Grouped counts are exact and unsuppressed, per the approved plan's §7.4
  // rationale: each bucket is the same filtered count the caller can already get
  // one value at a time, over rows `query_resource` returns in full. The
  // k-anonymous statistical path (`ai_get_patient_stats`) is unchanged and stays
  // the right tool for a *statistical release*; this is an authorized row read.
  aggregates: {
    groupBy: ["blood_type", "department_id", "assigned_doctor_id"],
    groups: {
      blood_type: {
        filter: "blood_type",
        description: "Blood type distribution across authorized patients.",
        domain: {
          kind: "enum",
          values: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
        },
        includeNull: true,
      },
      department_id: {
        filter: "department_id",
        description: "Patient distribution by assigned department.",
        domain: {
          kind: "resource",
          resource: "departments",
          labelField: "name",
          sort: "name",
        },
        includeNull: true,
      },
      assigned_doctor_id: {
        filter: "assigned_doctor_id",
        description: "Patient distribution by assigned doctor.",
        domain: {
          kind: "resource",
          resource: "profiles",
          labelField: "full_name",
          filters: { role: "doctor", is_active: true },
          sort: "full_name",
        },
        includeNull: true,
      },
    },
    metrics: ["count"],
  },
  labels: { en: "Patients", ar: "المرضى" },
  description: {
    en: "Authorized patient records, scoped by ClinicFlow RLS.",
    ar: "سجلات المرضى المصرح بها والمقيدة بسياسات ClinicFlow.",
  },
  baseFilters: [
    { column: "is_deleted", operator: "eq", value: false },
    { column: "deleted_at", operator: "is", value: null },
  ],
};
