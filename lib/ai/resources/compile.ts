import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getEntitlements, hasFeature } from "@/lib/entitlements";
import { AiToolAuthorizationError } from "@/lib/ai/errors";
import { assertResourceAccess, getResourceDefinition } from "@/lib/ai/resources/registry";
import { clinicTimeZoneMemo } from "@/lib/ai/resources/clinic-dates";
import { RESOURCE_IDS } from "@/lib/ai/resources/types";
import type {
  BaseFilter,
  CompiledFilter,
  CompiledResourceQuery,
  FilterOperator,
  ResourceClarification,
  ResourceCountResult,
  ResourceDefinition,
  ResourceFilterClause,
  ResourceFilterValue,
  ResourceGroupBucket,
  ResourceGroupSpec,
  ResourceGroupedCountResult,
  ResourceQueryInput,
  ResourceQueryHooks,
  ResourceQueryResult,
  ResourceScalar,
} from "@/lib/ai/resources/types";
import type { AuthedUser } from "@/lib/rbac";
import type { Database, Json } from "@/types/database";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_PAGE = 100;
export const HARD_ROW_CAP = 500;
/**
 * Ceiling on the number of buckets one grouped count may enumerate. Each bucket
 * is one exact `head` count against the caller's RLS client, so this bounds the
 * per-call query fan-out. A wider domain returns `invalid_aggregate` naming the
 * limit rather than silently reporting a partial distribution.
 */
export const MAX_GROUP_BUCKETS = 40;
/** Bucket counts issued per round trip batch. */
const GROUP_COUNT_CONCURRENCY = 8;

export type ResourceInputErrorReason =
  | "invalid_resource"
  | "invalid_field"
  | "invalid_relation"
  | "invalid_filter"
  | "invalid_operator"
  | "invalid_filter_value"
  | "invalid_sort"
  | "invalid_pagination"
  | "invalid_aggregate"
  | "sensitive_field_bulk_refused";

export class AiResourceInputError extends Error {
  readonly code = "AI_RESOURCE_INPUT_INVALID";

  constructor(
    public readonly reason: ResourceInputErrorReason,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AiResourceInputError";
  }

  toResult() {
    return {
      invalid_request: true as const,
      reason: this.reason,
      message: this.message,
      ...this.details,
    };
  }
}

function isClause(value: unknown): value is ResourceFilterClause {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      "operator" in value &&
      "value" in value,
  );
}

function parseFilterValue(
  key: string,
  operator: FilterOperator,
  raw: ResourceFilterValue,
  schema: { safeParse(value: unknown): { success: boolean; data?: ResourceScalar } },
): ResourceFilterValue {
  if (operator === "ilike" && typeof raw === "string" && raw.includes("*")) {
    // PostgREST expands `*` to `%` before PostgreSQL evaluates the pattern and
    // does not preserve a backslash-escaped star as a literal. Reject it so
    // model input cannot broaden the server-owned substring pattern.
    throw new AiResourceInputError(
      "invalid_filter_value",
      `Filter "${key}" cannot contain "*" with operator "ilike".`,
      { field: key, forbidden_character: "*" },
    );
  }
  if (operator === "is") {
    if (raw === null) return null;
    throw new AiResourceInputError(
      "invalid_filter_value",
      `Filter "${key}" with operator "is" accepts null only.`,
      { field: key },
    );
  }
  if (operator === "in") {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
      throw new AiResourceInputError(
        "invalid_filter_value",
        `Filter "${key}" with operator "in" requires 1–50 values.`,
        { field: key },
      );
    }
    const parsed = raw.map((value) => schema.safeParse(value));
    if (parsed.some((entry) => !entry.success)) {
      throw new AiResourceInputError(
        "invalid_filter_value",
        `Filter "${key}" contains an invalid value.`,
        { field: key },
      );
    }
    return parsed.map((entry) => entry.data ?? null);
  }
  if (Array.isArray(raw)) {
    throw new AiResourceInputError(
      "invalid_filter_value",
      `Filter "${key}" requires one value for operator "${operator}".`,
      { field: key },
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AiResourceInputError(
      "invalid_filter_value",
      `Filter "${key}" has an invalid value.`,
      { field: key },
    );
  }
  return parsed.data ?? null;
}

function compileFields(
  user: AuthedUser,
  definition: NonNullable<ReturnType<typeof getResourceDefinition>>,
  requested: readonly string[] | undefined,
): {
  names: string[];
  columns: string[];
  withheld: string[];
  sensitiveListLimit: number | null;
} {
  const names = requested?.length ? [...new Set(requested)] : [...definition.defaultFields];
  const known = new Set(Object.keys(definition.fields));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new AiResourceInputError(
      "invalid_field",
      `Unknown field for resource "${definition.id}".`,
      { fields: unknown, valid_fields: [...known] },
    );
  }

  const allowed = new Set(definition.fieldPolicy(user));
  const readable = names.filter((name) => allowed.has(name));
  const withheld = names.filter((name) => !allowed.has(name));
  if (readable.length === 0) {
    throw new AiResourceInputError(
      "invalid_field",
      `None of the requested fields are readable for resource "${definition.id}".`,
      { fields_withheld: withheld },
    );
  }
  return {
    names: readable,
    columns: readable.map((name) => definition.fields[name]!.column),
    withheld,
    sensitiveListLimit:
      readable.reduce<number | null>((limit, name) => {
        const fieldLimit = definition.fields[name]!.maxListRows ?? null;
        if (fieldLimit === null) return limit;
        return limit === null ? fieldLimit : Math.min(limit, fieldLimit);
      }, null),
  };
}

function compileRelations(
  user: AuthedUser,
  definition: NonNullable<ReturnType<typeof getResourceDefinition>>,
  requested: ResourceQueryInput["relations"],
): { selects: string[]; withheld: string[]; sensitiveListLimit: number | null } {
  if (!requested) {
    return { selects: [], withheld: [], sensitiveListLimit: null };
  }
  const selects: string[] = [];
  const withheld: string[] = [];
  let sensitiveListLimit: number | null = null;

  for (const [key, requestedFields] of Object.entries(requested)) {
    const relation = definition.relations[key];
    if (!relation) {
      throw new AiResourceInputError(
        "invalid_relation",
        `Unknown relation "${key}" for resource "${definition.id}".`,
        { relation: key, valid_relations: Object.keys(definition.relations) },
      );
    }
    const fields = requestedFields.length
      ? [...new Set(requestedFields)]
      : [...relation.defaultFields];
    const unknown = fields.filter((field) => !relation.fields[field]);
    if (unknown.length > 0) {
      throw new AiResourceInputError(
        "invalid_field",
        `Unknown field on relation "${key}".`,
        { fields: unknown, valid_fields: Object.keys(relation.fields) },
      );
    }
    const allowed = new Set(relation.fieldPolicy(user));
    const readable = fields.filter((field) => allowed.has(field));
    withheld.push(...fields.filter((field) => !allowed.has(field)).map((field) => `${key}.${field}`));
    for (const field of readable) {
      const fieldLimit = relation.fields[field]!.maxListRows ?? null;
      if (fieldLimit !== null) {
        sensitiveListLimit =
          sensitiveListLimit === null
            ? fieldLimit
            : Math.min(sensitiveListLimit, fieldLimit);
      }
    }
    if (readable.length > 0) {
      const columns = readable.map((field) => relation.fields[field]!.column);
      selects.push(`${relation.alias}:${relation.select}(${columns.join(",")})`);
    }
  }
  return { selects, withheld, sensitiveListLimit };
}

/** Pure compiler used by tests and by the authorized wrapper below. */
export function compileResourceQueryPlan(
  user: AuthedUser,
  resourceId: string,
  input: ResourceQueryInput = {},
): CompiledResourceQuery {
  const definition = getResourceDefinition(resourceId);
  if (!definition) {
    throw new AiResourceInputError(
      "invalid_resource",
      `Unknown resource "${resourceId}".`,
      { valid_resources: [...RESOURCE_IDS] },
    );
  }
  if (!definition.roles.includes(user.role)) {
    throw new AiToolAuthorizationError("role_forbidden");
  }

  const page = input.page ?? 1;
  const requestedPageSize = input.page_size ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, definition.rowCap, HARD_ROW_CAP);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > MAX_PAGE ||
    !Number.isSafeInteger(requestedPageSize) ||
    requestedPageSize < 1 ||
    requestedPageSize > MAX_PAGE_SIZE
  ) {
    throw new AiResourceInputError(
      "invalid_pagination",
      `page must be between 1 and ${MAX_PAGE}, and page_size must be between 1 and ${MAX_PAGE_SIZE}.`,
      { max_page: MAX_PAGE, max_page_size: MAX_PAGE_SIZE },
    );
  }

  const selected = compileFields(user, definition, input.fields);
  const relations = compileRelations(user, definition, input.relations);
  const filters: CompiledFilter[] = [];
  for (const [key, rawInput] of Object.entries(input.filters ?? {})) {
    const spec = definition.filters[key];
    if (!spec) {
      throw new AiResourceInputError(
        "invalid_filter",
        `Unknown filter "${key}" for resource "${definition.id}".`,
        { field: key, valid_filters: Object.keys(definition.filters) },
      );
    }
    const operator = isClause(rawInput) ? rawInput.operator : "eq";
    const raw = isClause(rawInput) ? rawInput.value : rawInput;
    if (!spec.operators.includes(operator)) {
      throw new AiResourceInputError(
        "invalid_operator",
        `Operator "${operator}" is not allowed for filter "${key}".`,
        { field: key, valid_operators: spec.operators },
      );
    }
    filters.push({
      key,
      column: spec.column,
      operator,
      value: parseFilterValue(key, operator, raw, spec.schema),
      resolver: spec.resolver,
    });
  }

  const readableSorts = definition.sorts.filter((key) =>
    new Set(definition.fieldPolicy(user)).has(key),
  );
  const sortKey = input.sort ?? readableSorts[0];
  if (!sortKey || !readableSorts.includes(sortKey)) {
    throw new AiResourceInputError(
      "invalid_sort",
      `Unknown sort key for resource "${definition.id}".`,
      { sort: sortKey, valid_sorts: readableSorts },
    );
  }
  const sortField = definition.fields[sortKey];
  if (!sortField) {
    throw new Error(`Resource "${definition.id}" declares non-field sort "${sortKey}".`);
  }

  const from = (page - 1) * pageSize;
  const baseFilters =
    typeof definition.baseFilters === "function"
      ? definition.baseFilters(user)
      : definition.baseFilters ?? [];
  const idFilter = filters.find((filter) => filter.key === "id");
  const exactIdLookup =
    idFilter?.operator === "eq" && typeof idFilter.value === "string";
  const tenantScope = definition.tenantScope ?? { column: "clinic_id" };
  const internalSelects = tenantScope.select ? [tenantScope.select] : [];

  return {
    resource: definition,
    select: [...selected.columns, ...relations.selects, ...internalSelects].join(","),
    fields: selected.names,
    fieldsWithheld: [...selected.withheld, ...relations.withheld],
    filters,
    baseFilters,
    sort: {
      key: sortKey,
      column: sortField.column,
      direction: input.direction ?? "asc",
    },
    // Offset pagination requires a total order. Every Phase 1 resource has a
    // UUID primary key, so this stabilizes ties and nullable primary sorts.
    tiebreak: { column: "id", direction: "asc" },
    page,
    pageSize,
    range: { from, toWithSentinel: from + pageSize },
    tenantPredicate: { column: tenantScope.column, value: user.clinicId },
    internalSelects,
    internalResultFields: tenantScope.resultAlias ? [tenantScope.resultAlias] : [],
    sensitiveListLimit:
      selected.sensitiveListLimit === null
        ? relations.sensitiveListLimit
        : relations.sensitiveListLimit === null
          ? selected.sensitiveListLimit
          : Math.min(
              selected.sensitiveListLimit,
              relations.sensitiveListLimit,
            ),
    exactIdLookup,
  };
}

export async function compileResourceQuery(
  user: AuthedUser,
  resourceId: string,
  input: ResourceQueryInput = {},
): Promise<CompiledResourceQuery> {
  const definition = getResourceDefinition(resourceId);
  if (!definition) return compileResourceQueryPlan(user, resourceId, input);
  await assertResourceAccess(user, definition);
  if ((input.page ?? 1) > 1) {
    const entitlements = await getEntitlements(user.clinicId);
    if (!hasFeature(entitlements, "ai.bulk_export")) {
      throw new AiToolAuthorizationError("feature_not_entitled");
    }
  }
  return compileResourceQueryPlan(user, resourceId, input);
}

type QueryResult = {
  data: unknown[] | null;
  error: { message?: string } | null;
  count: number | null;
};

type DynamicQuery = {
  select(columns: string, options?: { count?: "exact"; head?: boolean }): DynamicQuery;
  eq(column: string, value: unknown): DynamicQuery;
  neq(column: string, value: unknown): DynamicQuery;
  in(column: string, values: readonly unknown[]): DynamicQuery;
  gt(column: string, value: unknown): DynamicQuery;
  gte(column: string, value: unknown): DynamicQuery;
  lt(column: string, value: unknown): DynamicQuery;
  lte(column: string, value: unknown): DynamicQuery;
  ilike(column: string, value: string): DynamicQuery;
  is(column: string, value: unknown): DynamicQuery;
  order(column: string, options: { ascending: boolean }): DynamicQuery;
  range(from: number, to: number): DynamicQuery;
};

type DynamicClient = { from(table: string): DynamicQuery };

function applyFilter(query: DynamicQuery, filter: BaseFilter | CompiledFilter): DynamicQuery {
  switch (filter.operator) {
    case "eq":
      return query.eq(filter.column, filter.value);
    case "neq":
      return query.neq(filter.column, filter.value);
    case "in":
      return query.in(filter.column, Array.isArray(filter.value) ? filter.value : [filter.value]);
    case "gt":
      return query.gt(filter.column, filter.value);
    case "gte":
      return query.gte(filter.column, filter.value);
    case "lt":
      return query.lt(filter.column, filter.value);
    case "lte":
      return query.lte(filter.column, filter.value);
    case "ilike": {
      // The compiler owns the wildcard shape. Treat model-provided SQL LIKE
      // metacharacters as literal text so callers cannot silently broaden a
      // registered substring filter into an unrestricted pattern.
      // `*` is rejected during compilation because PostgREST does not preserve
      // it as a literal. Escape PostgreSQL's remaining LIKE metacharacters.
      const value = String(filter.value).replace(/[\\%_]/g, "\\$&");
      return query.ilike(filter.column, `%${value}%`);
    }
    case "is":
      return query.is(filter.column, filter.value);
  }
}

async function resolveCompiledFilters(
  compiled: CompiledResourceQuery,
  client: SupabaseClient<Database>,
  user: AuthedUser,
  hooks?: ResourceQueryHooks,
): Promise<readonly CompiledFilter[] | ResourceClarification> {
  const resolved: CompiledFilter[] = [];
  // Read once per resolution pass, and only if a filter actually asks for it —
  // a query with no clinic-local date costs no extra round trip (P7-02).
  const clinicTimeZone = clinicTimeZoneMemo(client, user.clinicId);
  const now = new Date();
  for (const item of compiled.filters) {
    if (!item.resolver) {
      resolved.push(item);
      continue;
    }
    if (Array.isArray(item.value)) {
      throw new AiResourceInputError(
        "invalid_filter_value",
        `Resolved filter "${item.key}" accepts one value.`,
        { field: item.key },
      );
    }
    const result = await item.resolver(item.value as ResourceScalar, {
      client,
      user,
      key: item.key,
      operator: item.operator,
      clinicTimeZone,
      now,
    });
    if (result.status === "resolved_range") {
      // One registered key, several clauses on the same server-owned column.
      // The model still named neither the column nor either bound.
      for (const clause of result.clauses) {
        resolved.push({
          ...item,
          operator: clause.operator,
          value: clause.value,
          resolver: undefined,
        });
      }
      continue;
    }
    if (result.status === "ambiguous") {
      return {
        needs_clarification: true,
        field: item.key,
        guidance: result.guidance,
        candidates: result.candidates,
      };
    }
    if (result.status === "not_found") {
      return {
        needs_clarification: true,
        field: item.key,
        guidance: result.guidance,
        candidates: [],
      };
    }
    // A trusted ranked resolution may seed conversation context. Emitted here
    // rather than returned in the result so it never becomes model-visible.
    if (result.context) hooks?.onResolvedContext?.(result.context);
    resolved.push({ ...item, value: result.value, resolver: undefined });
  }
  return resolved;
}

function isClarification(
  value: readonly CompiledFilter[] | ResourceClarification,
): value is ResourceClarification {
  return !Array.isArray(value);
}

function buildQuery(
  client: SupabaseClient<Database>,
  compiled: CompiledResourceQuery,
  filters: readonly CompiledFilter[],
  options: { countOnly: boolean },
): DynamicQuery {
  const countSelect = ["id", ...compiled.internalSelects].join(",");
  let query = (client as unknown as DynamicClient)
    .from(compiled.resource.table)
    .select(options.countOnly ? countSelect : compiled.select, {
      count: "exact",
      head: options.countOnly,
    })
    .eq(compiled.tenantPredicate.column, compiled.tenantPredicate.value);
  for (const filter of compiled.baseFilters) query = applyFilter(query, filter);
  for (const filter of filters) query = applyFilter(query, filter);
  return query;
}

async function queryResult(query: DynamicQuery): Promise<QueryResult> {
  return await (query as unknown as Promise<QueryResult>);
}

function scopeError(): AiToolAuthorizationError {
  return new AiToolAuthorizationError(
    "unauthorized_scope",
    "The requested record does not exist or is outside the caller's authorized scope.",
  );
}

export async function executeCompiledResourceQuery(
  user: AuthedUser,
  compiled: CompiledResourceQuery,
  client: SupabaseClient<Database>,
  hooks?: ResourceQueryHooks,
): Promise<ResourceQueryResult | ResourceClarification> {
  const filters = await resolveCompiledFilters(compiled, client, user, hooks);
  if (isClarification(filters)) return filters;

  if (compiled.sensitiveListLimit !== null && !compiled.exactIdLookup) {
    const countResult = await queryResult(
      buildQuery(client, compiled, filters, { countOnly: true }),
    );
    if (countResult.error) throw new Error("Resource sensitivity count failed.");
    if ((countResult.count ?? 0) > compiled.sensitiveListLimit) {
      throw new AiResourceInputError(
        "sensitive_field_bulk_refused",
        `This field cannot be returned for more than ${compiled.sensitiveListLimit} rows.`,
        { max_rows: compiled.sensitiveListLimit },
      );
    }
  }

  const result = await queryResult(
    buildQuery(client, compiled, filters, { countOnly: false })
      .order(compiled.sort.column, { ascending: compiled.sort.direction === "asc" })
      .order(compiled.tiebreak.column, {
        ascending: compiled.tiebreak.direction === "asc",
      })
      .range(compiled.range.from, compiled.range.toWithSentinel),
  );
  if (result.error) throw new Error("Resource query failed.");
  if (result.count === null) throw new Error("Resource query did not return an exact count.");
  if (compiled.exactIdLookup && result.count === 0) throw scopeError();

  const fetched = (result.data ?? []).filter(
    (row): row is Record<string, Json | undefined> =>
      Boolean(row && typeof row === "object" && !Array.isArray(row)),
  );
  const truncated = fetched.length > compiled.pageSize;
  const rows = fetched.slice(0, compiled.pageSize).map((row) => {
    if (compiled.internalResultFields.length === 0) return row;
    const visible = { ...row };
    for (const field of compiled.internalResultFields) delete visible[field];
    return visible;
  });
  return {
    resource: compiled.resource.id,
    rows,
    total: result.count,
    page: compiled.page,
    page_size: compiled.pageSize,
    row_cap: compiled.resource.rowCap,
    truncated,
    notice: truncated
      ? `Showing rows ${compiled.range.from + 1}–${compiled.range.from + rows.length} of ${result.count}.`
      : null,
    fields_withheld: compiled.fieldsWithheld,
  };
}

export async function executeCompiledResourceCount(
  user: AuthedUser,
  compiled: CompiledResourceQuery,
  client: SupabaseClient<Database>,
): Promise<ResourceCountResult | ResourceClarification> {
  const filters = await resolveCompiledFilters(compiled, client, user);
  if (isClarification(filters)) return filters;
  const result = await queryResult(buildQuery(client, compiled, filters, { countOnly: true }));
  if (result.error || result.count === null) throw new Error("Resource aggregate failed.");
  if (compiled.exactIdLookup && result.count === 0) throw scopeError();
  return {
    resource: compiled.resource.id,
    metric: "count",
    value: result.count,
    group_by: null,
  };
}

export async function queryResource(
  user: AuthedUser,
  resourceId: string,
  input: ResourceQueryInput = {},
  client?: SupabaseClient<Database>,
  hooks?: ResourceQueryHooks,
): Promise<ResourceQueryResult | ResourceClarification> {
  const compiled = await compileResourceQuery(user, resourceId, input);
  return executeCompiledResourceQuery(
    user,
    compiled,
    client ?? (await createClient()),
    hooks,
  );
}

export async function countResource(
  user: AuthedUser,
  resourceId: string,
  input: ResourceQueryInput = {},
  client?: SupabaseClient<Database>,
): Promise<ResourceCountResult | ResourceClarification> {
  const compiled = await compileResourceQuery(user, resourceId, {
    ...input,
    fields: ["id"],
    page: 1,
    page_size: 1,
  });
  return executeCompiledResourceCount(user, compiled, client ?? (await createClient()));
}

/**
 * Resolves the closed bucket set for a group key.
 *
 * The `resource` domain reads its labels through `queryResource`, i.e. the same
 * compiler, the same `assertResourceAccess` gates and the same RLS client as any
 * other read. A caller who may not read `departments` cannot group patients by
 * department, and a bucket can never name a lookup row outside the caller's
 * scope — the narrowing is inherited, never re-implemented here.
 */
async function resolveGroupBuckets(
  user: AuthedUser,
  spec: ResourceGroupSpec,
  client: SupabaseClient<Database>,
): Promise<readonly { key: string; label: string }[]> {
  const domain = spec.domain;
  if (domain.kind === "enum") {
    return domain.values.map((value) => ({ key: value, label: value }));
  }
  const lookup = await queryResource(
    user,
    domain.resource,
    {
      fields: ["id", domain.labelField],
      filters: domain.filters,
      sort: domain.sort,
      page: 1,
      page_size: MAX_GROUP_BUCKETS + 1,
    },
    client,
  );
  if ("needs_clarification" in lookup) {
    throw new AiResourceInputError(
      "invalid_aggregate",
      `Group lookup for "${domain.resource}" could not be resolved.`,
      { group_lookup: domain.resource },
    );
  }
  return lookup.rows.flatMap((row) => {
    const key = row.id;
    if (typeof key !== "string") return [];
    const label = row[domain.labelField];
    return [{ key, label: typeof label === "string" && label ? label : key }];
  });
}

async function countBuckets(
  user: AuthedUser,
  resourceId: string,
  baseFilters: ResourceQueryInput["filters"],
  spec: ResourceGroupSpec,
  buckets: readonly { key: string; label: string }[],
  client: SupabaseClient<Database>,
): Promise<ResourceGroupBucket[]> {
  const counted: ResourceGroupBucket[] = [];
  for (let index = 0; index < buckets.length; index += GROUP_COUNT_CONCURRENCY) {
    const batch = buckets.slice(index, index + GROUP_COUNT_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (bucket) => {
        const result = await countResource(
          user,
          resourceId,
          { filters: { ...baseFilters, [spec.filter]: bucket.key } },
          client,
        );
        return "needs_clarification" in result ? null : result.value;
      }),
    );
    results.forEach((value, offset) => {
      if (value === null) return;
      counted.push({ key: batch[offset]!.key, label: batch[offset]!.label, count: value });
    });
  }
  return counted;
}

/**
 * Grouped, exact, unsuppressed counts over a registered resource.
 *
 * Approved plan §7.4 keeps k-anonymity on the *statistical* patient path
 * (`ai_get_patient_stats`) and deliberately leaves the resource path exact,
 * because "a clinic user listing records they are authorized to read is not
 * treated as a statistical disclosure". This extends that same rule from a
 * single filtered cell to the set of cells: every bucket here is literally the
 * count the caller already gets from `aggregate_resource` one filter value at a
 * time, and every bucket's rows are ones `query_resource` will return in full.
 * Suppressing the assembled view while publishing each of its parts protects
 * nothing and is exactly what produced the false "cannot be shown" answers.
 */
export async function groupedCountResource(
  user: AuthedUser,
  resourceId: string,
  groupBy: string,
  input: ResourceQueryInput = {},
  client?: SupabaseClient<Database>,
): Promise<ResourceGroupedCountResult> {
  const definition = getResourceDefinition(resourceId);
  if (!definition) {
    throw new AiResourceInputError(
      "invalid_resource",
      `Unknown resource "${resourceId}".`,
      { valid_resources: [...RESOURCE_IDS] },
    );
  }
  const spec = groupSpec(definition, groupBy);
  if (Object.hasOwn(input.filters ?? {}, spec.filter) || Object.hasOwn(input.filters ?? {}, groupBy)) {
    throw new AiResourceInputError(
      "invalid_aggregate",
      `Cannot group by "${groupBy}" while also filtering on it. Drop the filter, or count that single value with metric "count".`,
      { field: groupBy },
    );
  }
  // Authorization for the grouped resource itself is asserted before any lookup
  // read, so an unauthorized resource never leaks the existence of its groups.
  await assertResourceAccess(user, definition);

  const supabase = client ?? (await createClient());
  const buckets = await resolveGroupBuckets(user, spec, supabase);
  if (buckets.length > MAX_GROUP_BUCKETS) {
    throw new AiResourceInputError(
      "invalid_aggregate",
      `Grouping "${resourceId}" by "${groupBy}" would produce more than ${MAX_GROUP_BUCKETS} groups. Narrow the request with filters first.`,
      { field: groupBy, max_groups: MAX_GROUP_BUCKETS },
    );
  }

  const counted = await countBuckets(
    user,
    resourceId,
    input.filters,
    spec,
    buckets,
    supabase,
  );
  const nullBucket = spec.includeNull
    ? await countResource(
        user,
        resourceId,
        {
          filters: { ...input.filters, [spec.filter]: { operator: "is", value: null } },
        },
        supabase,
      )
    : null;
  if (nullBucket && !("needs_clarification" in nullBucket) && nullBucket.value > 0) {
    counted.push({ key: null, label: "(none)", count: nullBucket.value });
  }

  const total = await countResource(user, resourceId, { filters: input.filters }, supabase);
  const nonEmpty = counted.filter((bucket) => bucket.count > 0);
  const totalValue = "needs_clarification" in total ? null : total.value;
  const bucketSum = nonEmpty.reduce((sum, bucket) => sum + bucket.count, 0);

  return {
    resource: definition.id,
    metric: "count",
    group_by: groupBy,
    groups: [...nonEmpty].sort((a, b) => b.count - a.count),
    total: totalValue ?? bucketSum,
    empty_groups_omitted: counted.length - nonEmpty.length,
    suppressed: false,
    // Honest reconciliation: a row whose group value falls outside the enumerated
    // domain (or is null when no null bucket was requested) is in the total but in
    // no bucket, and the model must not silently attribute it to one.
    notice:
      totalValue !== null && totalValue !== bucketSum
        ? `${totalValue - bucketSum} of ${totalValue} record(s) fall outside the listed groups.`
        : null,
  };
}

function groupSpec(
  definition: ResourceDefinition,
  groupBy: string,
): ResourceGroupSpec {
  const spec = definition.aggregates?.groups?.[groupBy];
  if (!spec || !definition.aggregates?.groupBy.includes(groupBy)) {
    throw new AiResourceInputError(
      "invalid_aggregate",
      `Grouping by "${groupBy}" is not available for resource "${definition.id}".`,
      { valid_group_by: definition.aggregates?.groupBy ?? [] },
    );
  }
  return spec;
}
