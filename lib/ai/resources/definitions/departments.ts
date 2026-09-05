import "server-only";

import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import { booleanSchema, filter, shortTextSchema, timestampSchema, uuidSchema } from "@/lib/ai/resources/filters";
import type { ResourceDefinition } from "@/lib/ai/resources/types";

const fields = {
  id: field("id", "string", "identifier", "Department id."),
  name: field("name", "string", "operational", "Department name."),
  description: field("description", "string", "operational", "Department description."),
  color: field("color", "string", "operational", "Display color."),
  is_active: field("is_active", "boolean", "operational", "Whether the department is active."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
} satisfies ResourceDefinition["fields"];

export const departmentsResource: ResourceDefinition = {
  id: "departments",
  table: "departments",
  // Broader than the Settings page by design: departments_select_own grants
  // every authenticated clinic role the tenant's department reference data.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Department id."),
    name: filter("name", shortTextSchema, ["eq", "ilike"], "Department name."),
    is_active: filter("is_active", booleanSchema, ["eq"], "Active state."),
    created_at: filter("created_at", timestampSchema, ["gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["name", "created_at"],
  relations: {},
  defaultFields: ["id", "name", "description", "is_active"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Departments", ar: "الأقسام" },
  description: { en: "Clinic departments.", ar: "أقسام العيادة." },
  baseFilters: [{ column: "deleted_at", operator: "is", value: null }],
};
