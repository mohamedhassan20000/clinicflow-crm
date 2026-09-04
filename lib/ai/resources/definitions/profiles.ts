import "server-only";

import { z } from "zod";
import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import {
  booleanSchema,
  filter,
  resolveDepartmentResourceFilter,
  shortTextSchema,
  timestampSchema,
  uuidSchema,
} from "@/lib/ai/resources/filters";
import type { ResourceDefinition } from "@/lib/ai/resources/types";

const fields = {
  id: field("id", "string", "identifier", "Staff profile id."),
  full_name: field("full_name", "string", "operational", "Staff full name."),
  role: field("role", "string", "operational", "Clinic role."),
  department_id: field("department_id", "string", "operational", "Department id."),
  phone: field("phone", "string", "contact", "Staff phone number."),
  professional_title: field("professional_title", "string", "operational", "Professional title."),
  specialty: field("specialty", "string", "operational", "Clinical specialty."),
  professional_license_no: field("professional_license_no", "string", "identifier", "Professional license number."),
  is_active: field("is_active", "boolean", "operational", "Whether the staff account is active."),
  last_login_at: field("last_login_at", "timestamp", "internal", "Last login time."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];
const department = {
  id: field("id", "string", "identifier", "Department id."),
  name: field("name", "string", "operational", "Department name."),
};

export const profilesResource: ResourceDefinition = {
  id: "profiles",
  table: "profiles",
  // Broader than the Settings page by design: profiles_select_same_clinic
  // grants every authenticated clinic role the same-clinic staff directory.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Staff id."),
    full_name: filter("full_name", shortTextSchema, ["eq", "ilike"], "Staff name."),
    role: filter(
      "role",
      z.enum(["admin", "manager", "receptionist", "doctor", "assistant"]),
      ["eq", "in"],
      "Clinic role.",
    ),
    department: filter("department_id", shortTextSchema, ["eq"], "Department name or id.", resolveDepartmentResourceFilter),
    department_id: filter("department_id", uuidSchema, ["eq", "in", "is"], "Department id."),
    is_active: filter("is_active", booleanSchema, ["eq"], "Active state."),
    created_at: filter("created_at", timestampSchema, ["gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["full_name", "role", "created_at", "last_login_at"],
  relations: {
    department: {
      alias: "department",
      select: "departments!profiles_department_id_fkey",
      fields: department,
      fieldPolicy: declaredFieldPolicy(department),
      defaultFields: ["id", "name"],
      description: "Staff department.",
    },
  },
  defaultFields: ["id", "full_name", "role", "department_id", "professional_title", "specialty", "is_active"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Staff", ar: "الموظفون" },
  description: { en: "Clinic staff profiles.", ar: "ملفات موظفي العيادة." },
  baseFilters: [
    { column: "is_deleted", operator: "eq", value: false },
    { column: "deleted_at", operator: "is", value: null },
  ],
};
