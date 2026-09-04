import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import type { AiCommercialFeature } from "@/lib/ai/commercial-policy";
import type { AiUserPermissionKey } from "@/lib/ai/permissions";
import type { AuthedUser, UserRole } from "@/lib/rbac";
import type { Database, Json } from "@/types/database";

export const RESOURCE_IDS = [
  "patients",
  "appointments",
  "departments",
  "services",
  "profiles",
  "follow_ups",
  "documents",
  "insurance_providers",
  "medical_notes",
  "prescriptions",
  "lab_requests",
  "sick_leaves",
  "patient_packages",
] as const;

export type ResourceId = (typeof RESOURCE_IDS)[number];
export type ResourceTable = ResourceId;

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "in",
  "gt",
  "gte",
  "lt",
  "lte",
  "ilike",
  "is",
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];
export type SortDirection = "asc" | "desc";
export type ResourceScalar = string | number | boolean | null;
export type ResourceFilterValue = ResourceScalar | readonly ResourceScalar[];

export type ResourceFilterClause = {
  operator: FilterOperator;
  value: ResourceFilterValue;
};

export type ResourceQueryInput = {
  fields?: readonly string[];
  filters?: Readonly<Record<string, ResourceFilterValue | ResourceFilterClause>>;
  relations?: Readonly<Record<string, readonly string[]>>;
  sort?: string;
  direction?: SortDirection;
  page?: number;
  page_size?: number;
};

export type ResourceAggregateInput = Pick<ResourceQueryInput, "filters"> & {
  metric?: "count";
  group_by?: string;
};

export type FieldSensitivity =
  | "operational"
  | "contact"
  | "clinical"
  | "identifier"
  | "internal";

export type FieldSpec = {
  /** Server-owned database column. Never accepted from model input. */
  column: string;
  type: "string" | "number" | "boolean" | "date" | "timestamp" | "json";
  sensitivity: FieldSensitivity;
  description: string;
  roles?: readonly UserRole[];
  /** Refuse list results above this size when the field is explicitly selected. */
  maxListRows?: number;
};

/**
 * A conversation-context slot a filter resolution earned.
 *
 * Present only when the resolver reached a *deterministic ranked* match on text
 * the user wrote (`trustedForContext`). A uuid the model asserted is revalidated
 * for the call it was given but never becomes trusted session state — the same
 * boundary `lib/ai/tools/entity-filters.ts` documents and the P4.10 tools held.
 */
export type ResolvedFilterContext = {
  entityType: "staff" | "department";
  id: string;
  label: string;
};

export type ResolvedFilter =
  | {
      status: "resolved";
      value: ResourceFilterValue;
      context?: ResolvedFilterContext;
    }
  | {
      /**
       * One registered filter key that expands into several clauses on the same
       * server-owned column (P7-02).
       *
       * A clinic-local calendar day is a *span*, not an instant: `scheduled_at`
       * equal to "today" is `>= start of the clinic's day` and `<= its end`. The
       * removed appointment tools resolved that span server-side and emitted
       * both bounds; this is how the generic path keeps doing so without letting
       * the model name either instant.
       */
      status: "resolved_range";
      clauses: readonly { operator: FilterOperator; value: ResourceScalar }[];
    }
  | {
      status: "ambiguous";
      candidates: readonly { id: string; name: string }[];
      guidance: string;
    }
  | { status: "not_found"; guidance: string };

export type FilterResolverContext = {
  client: SupabaseClient<Database>;
  user: AuthedUser;
  key: string;
  /**
   * The registered operator the caller asked for. A date resolver needs it:
   * `gte "2026-08-15"` is the *start* of that clinic day while `lte` is its
   * *end*, and collapsing the two would quietly drop the last day of a range.
   */
  operator: FilterOperator;
  /**
   * The clinic's IANA timezone, read from the authenticated request and memoized
   * for the resolution pass. A function rather than a value so a query with no
   * clinic-local filter costs no extra read.
   */
  clinicTimeZone: () => Promise<string>;
  /** Server clock for the turn. The model never supplies the anchor date. */
  now: Date;
};

export type FilterSpec = {
  /** Server-owned database column. Never accepted from model input. */
  column: string;
  operators: readonly FilterOperator[];
  schema: z.ZodType<ResourceScalar>;
  description: string;
  resolver?: (
    value: ResourceScalar,
    context: FilterResolverContext,
  ) => Promise<ResolvedFilter>;
};

export type RelationSpec = {
  /** Model-visible relation id. */
  alias: string;
  /** Server-owned PostgREST relation expression. */
  select: string;
  fields: Record<string, FieldSpec>;
  fieldPolicy: (user: AuthedUser) => readonly string[];
  defaultFields: readonly string[];
  description: string;
};

export type BaseFilter = {
  column: string;
  operator: Extract<FilterOperator, "eq" | "neq" | "in" | "is">;
  value: ResourceFilterValue;
};

/**
 * How the server enumerates the buckets of a grouped count.
 *
 * The model never supplies a bucket value: it names a registered group key and
 * the server derives the closed set of buckets, either from a declared enum or
 * from another *registered resource* read through the same caller's RLS client
 * and the same `assertResourceAccess` gates. Grouping by a lookup the caller
 * may not read is therefore denied by the lookup itself, not by a second
 * authorization model.
 */
export type ResourceGroupDomain =
  | { kind: "enum"; values: readonly string[] }
  | {
      kind: "resource";
      resource: ResourceId;
      labelField: string;
      /** Server-owned narrowing of the lookup (never model input). */
      filters?: Readonly<Record<string, ResourceFilterValue | ResourceFilterClause>>;
      sort?: string;
    };

export type ResourceGroupSpec = {
  /**
   * The registered filter key each bucket count is compiled through. Grouping
   * therefore adds no new predicate surface: a bucket is exactly the count the
   * caller would get by asking for that filter value directly.
   */
  filter: string;
  description: string;
  domain: ResourceGroupDomain;
  /**
   * Emit an explicit bucket for rows whose value is null. Requires the group's
   * filter to declare the `is` operator; asserted by a registry-invariant test.
   */
  includeNull?: boolean;
};

export type ResourceAggregates = {
  groupBy: readonly string[];
  /** One spec per `groupBy` key. Asserted to agree by a registry invariant. */
  groups?: Readonly<Record<string, ResourceGroupSpec>>;
  metrics: readonly ["count"];
  kAnonymity?: number;
};

export type ResourceDefinition = {
  id: ResourceId;
  table: ResourceTable;
  roles: readonly UserRole[];
  requiredFeatures: readonly AiCommercialFeature[];
  requiredUserPermission?: AiUserPermissionKey;
  fields: Record<string, FieldSpec>;
  fieldPolicy: (user: AuthedUser) => readonly string[];
  filters: Record<string, FilterSpec>;
  sorts: readonly string[];
  relations: Record<string, RelationSpec>;
  defaultFields: readonly string[];
  rowCap: number;
  aggregates?: ResourceAggregates;
  labels: { en: string; ar: string };
  description: { en: string; ar: string };
  baseFilters?: readonly BaseFilter[] | ((user: AuthedUser) => readonly BaseFilter[]);
  /**
   * Most resources carry `clinic_id` directly. Legacy tables such as
   * `medical_notes` scope through their patient relation instead; the hidden
   * inner embed lets the compiler retain its explicit tenant predicate without
   * exposing the helper relation in tool output.
   */
  tenantScope?: {
    column: string;
    select?: string;
    resultAlias?: string;
  };
};

export type CompiledFilter = {
  key: string;
  column: string;
  operator: FilterOperator;
  value: ResourceFilterValue;
  resolver?: FilterSpec["resolver"];
};

export type CompiledResourceQuery = {
  resource: ResourceDefinition;
  select: string;
  fields: readonly string[];
  fieldsWithheld: readonly string[];
  filters: readonly CompiledFilter[];
  baseFilters: readonly BaseFilter[];
  sort: { key: string; column: string; direction: SortDirection };
  tiebreak: { column: "id"; direction: "asc" };
  page: number;
  pageSize: number;
  range: { from: number; toWithSentinel: number };
  tenantPredicate: { column: string; value: string };
  internalSelects: readonly string[];
  internalResultFields: readonly string[];
  sensitiveListLimit: number | null;
  exactIdLookup: boolean;
};

/**
 * Out-of-band signals a resource read may emit. Never part of the model-visible
 * result: `onResolvedContext` feeds the server-side conversation-context
 * recorder, which the route persists and the UI renders.
 */
export type ResourceQueryHooks = {
  onResolvedContext?: (context: ResolvedFilterContext) => void;
};

export type ResourceClarification = {
  needs_clarification: true;
  field: string;
  guidance: string;
  candidates: readonly { id: string; name: string }[];
};

export type ResourceQueryResult = {
  resource: ResourceId;
  rows: readonly Record<string, Json | undefined>[];
  total: number;
  page: number;
  page_size: number;
  row_cap: number;
  truncated: boolean;
  notice: string | null;
  fields_withheld: readonly string[];
};

export type ResourceCountResult = {
  resource: ResourceId;
  metric: "count";
  value: number;
  group_by: null;
};

export type ResourceGroupBucket = {
  /** The registered filter value for this bucket, or null for the null bucket. */
  key: string | null;
  label: string;
  count: number;
};

/**
 * A grouped count derived from rows the caller is already authorized to read.
 *
 * `suppressed: false` is part of the contract, not decoration: it is what tells
 * the model this is the authorized row-derived path rather than the k-anonymous
 * statistical path, so a small bucket here is a real answer and must not be
 * reported as withheld.
 */
export type ResourceGroupedCountResult = {
  resource: ResourceId;
  metric: "count";
  group_by: string;
  groups: readonly ResourceGroupBucket[];
  total: number;
  empty_groups_omitted: number;
  suppressed: false;
  notice: string | null;
};
