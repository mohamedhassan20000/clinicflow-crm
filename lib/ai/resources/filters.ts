import "server-only";

import { z } from "zod";
import {
  resolveDepartmentFilter,
  resolveDoctorFilter,
} from "@/lib/ai/tools/entity-filters";
import {
  CLINIC_DATE_PRESETS,
  isClinicLocalDateInput,
  resolveClinicLocalRange,
} from "@/lib/ai/resources/clinic-dates";
import type {
  FilterResolverContext,
  FilterSpec,
  ResolvedFilter,
  ResolvedFilterContext,
  ResourceScalar,
} from "@/lib/ai/resources/types";

export const uuidSchema = z.string().uuid();
export const shortTextSchema = z.string().trim().min(1).max(160);
export const booleanSchema = z.boolean();
export const numberSchema = z.number().finite();
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const timestampSchema = z.string().datetime({ offset: true });

/**
 * A timestamp filter that also accepts the clinic-local forms the superseded
 * appointment tools took (P7-02): a `YYYY-MM-DD` clinic calendar date, or one of
 * the named clinic-local periods. The absolute-instant form is kept first and
 * unchanged, so every existing caller and every existing test keeps working —
 * this widens what the model may say, never what it may reach.
 */
export const clinicTimestampSchema = z.union([
  timestampSchema,
  isoDateSchema,
  z.enum(CLINIC_DATE_PRESETS),
]);

/** Model-facing wording for the clinic-local forms, appended to a description. */
export const CLINIC_LOCAL_DATE_GUIDANCE =
  `Accepts an absolute ISO instant with an offset, a clinic-local calendar date ` +
  `(YYYY-MM-DD), or a named clinic-local period (${CLINIC_DATE_PRESETS.join(", ")}). ` +
  `Clinic-local values are resolved to UTC bounds by the server in the clinic's own ` +
  `timezone against the server clock, so never compute an offset or a current date ` +
  `yourself — say "today" and let the server anchor it.`;

/**
 * Resolves a clinic-local day or period on a timestamp filter to server-owned
 * UTC bounds (P7-02). Absolute instants pass through untouched.
 *
 * The operator decides which bound a single-value form maps to, so a day stays a
 * span rather than collapsing to its midnight:
 *   `gte D` / `lt D` → the start of D;  `gt D` / `lte D` → the end of D;
 *   `eq D`           → both, as a `gte`+`lte` pair.
 */
export async function resolveClinicTimestampFilter(
  value: ResourceScalar,
  context: FilterResolverContext,
): Promise<ResolvedFilter> {
  const raw = String(value);
  if (!isClinicLocalDateInput(raw)) {
    // An offset-bearing instant. Pre-Phase-7 behaviour, byte for byte.
    return { status: "resolved", value: raw };
  }

  const timeZone = await context.clinicTimeZone();
  const range = resolveClinicLocalRange(raw, timeZone, context.now);
  if (!range) {
    // Unreachable while the schema and `isClinicLocalDateInput` agree; failing
    // closed here keeps a future schema widening from silently reaching the
    // database with an unresolved value.
    return {
      status: "not_found",
      guidance: `"${raw}" is not a clinic-local date this filter can resolve.`,
    };
  }

  switch (context.operator) {
    case "gte":
    case "lt":
      return { status: "resolved", value: range.start };
    case "gt":
    case "lte":
      return { status: "resolved", value: range.end };
    case "eq":
      return {
        status: "resolved_range",
        clauses: [
          { operator: "gte", value: range.start },
          { operator: "lte", value: range.end },
        ],
      };
    default:
      return {
        status: "not_found",
        guidance: `Operator "${context.operator}" does not accept a clinic-local date.`,
      };
  }
}

/** A timestamp filter carrying the clinic-local resolution above. */
export function clinicTimestampFilter(
  column: string,
  operators: FilterSpec["operators"],
  description: string,
): FilterSpec {
  return filter(
    column,
    clinicTimestampSchema,
    operators,
    `${description} ${CLINIC_LOCAL_DATE_GUIDANCE}`,
    resolveClinicTimestampFilter,
  );
}

export function filter(
  column: string,
  schema: FilterSpec["schema"],
  operators: FilterSpec["operators"],
  description: string,
  resolver?: FilterSpec["resolver"],
): FilterSpec {
  return { column, schema, operators, description, resolver };
}

function fromEntityResolution(
  key: string,
  input: string,
  resolution: Awaited<ReturnType<typeof resolveDepartmentFilter>>,
  entityType: ResolvedFilterContext["entityType"],
): ResolvedFilter {
  if (resolution.status === "resolved") {
    return {
      status: "resolved",
      value: resolution.id,
      // Only a deterministic ranked match on the user's own words may become
      // conversation context; a model-asserted uuid may not (P4.10A).
      context: resolution.trustedForContext
        ? { entityType, id: resolution.id, label: resolution.label }
        : undefined,
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidates: resolution.candidates,
      guidance: `More than one ${key} matches "${input}". Ask the user to choose one before retrying.`,
    };
  }
  return {
    status: "not_found",
    guidance: `No active ${key} matches "${input}". Ask the user to confirm the name.`,
  };
}

export async function resolveDepartmentResourceFilter(
  value: ResourceScalar,
  context: FilterResolverContext,
): Promise<ResolvedFilter> {
  const input = String(value);
  return fromEntityResolution(
    context.key,
    input,
    await resolveDepartmentFilter(context.client, input),
    "department",
  );
}

export async function resolveDoctorResourceFilter(
  value: ResourceScalar,
  context: FilterResolverContext,
): Promise<ResolvedFilter> {
  const input = String(value);
  return fromEntityResolution(
    context.key,
    input,
    await resolveDoctorFilter(context.client, input),
    "staff",
  );
}
