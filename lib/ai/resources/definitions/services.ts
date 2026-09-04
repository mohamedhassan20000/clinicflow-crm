import "server-only";

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
  id: field("id", "string", "identifier", "Service id."),
  name: field("name", "string", "operational", "Service name."),
  department_id: field("department_id", "string", "operational", "Department id."),
  price: field("price", "number", "operational", "Configured service price."),
  is_active: field("is_active", "boolean", "operational", "Whether the service is active."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];
const department = {
  id: field("id", "string", "identifier", "Department id."),
  name: field("name", "string", "operational", "Department name."),
};

export const servicesResource: ResourceDefinition = {
  id: "services",
  table: "services",
  // Broader than the Settings page by design: services_select grants every
  // authenticated clinic role this tenant-scoped service reference data.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Service id."),
    name: filter("name", shortTextSchema, ["eq", "ilike"], "Service name."),
    department: filter("department_id", shortTextSchema, ["eq"], "Department name or id.", resolveDepartmentResourceFilter),
    department_id: filter("department_id", uuidSchema, ["eq", "in"], "Department id."),
    is_active: filter("is_active", booleanSchema, ["eq"], "Active state."),
    created_at: filter("created_at", timestampSchema, ["gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["name", "price", "created_at", "updated_at"],
  relations: {
    department: {
      alias: "department",
      select: "departments!services_department_id_fkey",
      fields: department,
      fieldPolicy: declaredFieldPolicy(department),
      defaultFields: ["id", "name"],
      description: "Owning department.",
    },
  },
  defaultFields: ["id", "name", "department_id", "price", "is_active"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Services", ar: "الخدمات" },
  description: { en: "Clinic services and configured prices.", ar: "خدمات العيادة وأسعارها المحددة." },
  baseFilters: [{ column: "deleted_at", operator: "is", value: null }],
};
