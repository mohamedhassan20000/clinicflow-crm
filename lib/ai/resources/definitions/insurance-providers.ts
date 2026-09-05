import "server-only";

import { declaredFieldPolicy, field } from "@/lib/ai/resources/fields";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import { booleanSchema, filter, shortTextSchema, timestampSchema, uuidSchema } from "@/lib/ai/resources/filters";
import type { ResourceDefinition } from "@/lib/ai/resources/types";

const fields = {
  id: field("id", "string", "identifier", "Insurance provider id."),
  name: field("name", "string", "operational", "Insurance provider name."),
  code: field("code", "string", "operational", "Provider code."),
  is_active: field("is_active", "boolean", "operational", "Whether the provider is active."),
  created_at: field("created_at", "timestamp", "internal", "Record creation time."),
  updated_at: field("updated_at", "timestamp", "internal", "Last update time."),
} satisfies ResourceDefinition["fields"];

export const insuranceProvidersResource: ResourceDefinition = {
  id: "insurance_providers",
  table: "insurance_providers",
  // Broader than the Settings page by design: insurance_select_clinic grants
  // every authenticated clinic role this tenant-scoped reference data.
  roles: PERMISSION_USER_ROLES,
  requiredFeatures: ["ai.read_operational"],
  fields,
  fieldPolicy: declaredFieldPolicy(fields),
  filters: {
    id: filter("id", uuidSchema, ["eq", "in"], "Insurance provider id."),
    name: filter("name", shortTextSchema, ["eq", "ilike"], "Provider name."),
    code: filter("code", shortTextSchema, ["eq", "ilike", "is"], "Provider code."),
    is_active: filter("is_active", booleanSchema, ["eq"], "Active state."),
    created_at: filter("created_at", timestampSchema, ["gt", "gte", "lt", "lte"], "Creation time."),
  },
  sorts: ["name", "code", "created_at", "updated_at"],
  relations: {},
  defaultFields: ["id", "name", "code", "is_active"],
  rowCap: 200,
  aggregates: { groupBy: [], metrics: ["count"] },
  labels: { en: "Insurance providers", ar: "شركات التأمين" },
  description: { en: "Clinic insurance providers.", ar: "شركات التأمين الخاصة بالعيادة." },
  baseFilters: [{ column: "deleted_at", operator: "is", value: null }],
};
