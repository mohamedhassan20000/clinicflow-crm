import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyConfidence, transliterateQuery } from "@/lib/ai/entity-search";
import type { Database } from "@/types/database";

/**
 * Doctor / department filter resolution for the operational tools (P4.6A).
 *
 * The model may name a doctor or department in words rather than supply a uuid.
 * Resolution reuses the P4.6C contract exactly: ranking is deterministic and
 * database-native (`search_staff_ranked` / `search_departments_ranked`, both
 * SECURITY INVOKER so RLS decides visibility), and the caller proceeds only on a
 * confident unique match. Anything less returns candidates for the user to
 * choose from — the model never picks a namesake on its own.
 */
export type FilterResolution =
  | { status: "unset"; id: null }
  | { status: "resolved"; id: string; label: string }
  | { status: "ambiguous"; id: null; candidates: { id: string; name: string }[] }
  | { status: "not_found"; id: null };

const CANDIDATE_LIMIT = 5;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RankedRow = { id: string; score: number } & ({ full_name: string } | { name: string });

function rowLabel(row: RankedRow): string {
  return "full_name" in row ? row.full_name : row.name;
}

async function resolveRanked(
  rows: RankedRow[] | null,
): Promise<FilterResolution> {
  const candidates = (rows ?? []).slice(0, CANDIDATE_LIMIT);
  if (candidates.length === 0) return { status: "not_found", id: null };

  const confidence = classifyConfidence(candidates.map((row) => row.score));
  if (confidence === "high") {
    const top = candidates[0]!;
    return { status: "resolved", id: top.id, label: rowLabel(top) };
  }
  return {
    status: "ambiguous",
    id: null,
    candidates: candidates.map((row) => ({ id: row.id, name: rowLabel(row) })),
  };
}

/**
 * Verifies a uuid the model supplied against the caller's own visibility.
 *
 * A uuid-shaped argument used to short-circuit resolution entirely — no lookup,
 * no clinic check, no existence check. That contradicts the trust boundary this
 * whole module exists to hold: ids come from resolution or user choice, and the
 * model never *asserts* an entity id from free text. `get_clinic_summary` hands
 * the model a legitimate id directory, but it also has conversation history and
 * can hallucinate, and a stale-but-valid id produced a confidently wrong report
 * about the wrong doctor with no clarification path.
 *
 * RLS already made a *foreign* id harmless (the list came back empty). The real
 * defect was silence, so an unverifiable id now returns `not_found` and the
 * tool asks, exactly as it would for an unmatched name.
 */
// Synchronous, and named for what it does. It was `async` and awaited nothing
// (review #2, L6), which made it read as though it performed the verification —
// the caller does the read; this only classifies the result of one.
function verifiedId(
  id: string,
  label: unknown,
  error: unknown,
  entity: string,
): FilterResolution {
  if (error) throw new Error(`${entity} lookup failed.`);
  if (typeof label !== "string") return { status: "not_found", id: null };
  return { status: "resolved", id, label };
}

export async function resolveDoctorFilter(
  supabase: SupabaseClient<Database>,
  value: string | undefined,
): Promise<FilterResolution> {
  if (!value?.trim()) return { status: "unset", id: null };
  if (UUID_RE.test(value.trim())) {
    const id = value.trim();
    // The RLS client decides visibility, so this can never confirm an id
    // outside the caller's clinic.
    const { data, error } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", id)
      .eq("role", "doctor")
      .eq("is_deleted", false)
      .eq("is_active", true)
      .maybeSingle();
    return verifiedId(id, data?.full_name, error, "Doctor");
  }

  const { data, error } = await supabase.rpc("search_staff_ranked", {
    p_query: value.trim(),
    p_query_alt: transliterateQuery(value) ?? undefined,
    p_role: "doctor",
    p_limit: CANDIDATE_LIMIT,
  });
  if (error) throw new Error("Doctor lookup failed.");
  return resolveRanked(data as RankedRow[] | null);
}

export async function resolveDepartmentFilter(
  supabase: SupabaseClient<Database>,
  value: string | undefined,
): Promise<FilterResolution> {
  if (!value?.trim()) return { status: "unset", id: null };
  if (UUID_RE.test(value.trim())) {
    const id = value.trim();
    const { data, error } = await supabase
      .from("departments")
      .select("name")
      .eq("id", id)
      .is("deleted_at", null)
      .eq("is_active", true)
      .maybeSingle();
    return verifiedId(id, data?.name, error, "Department");
  }

  const { data, error } = await supabase.rpc("search_departments_ranked", {
    p_query: value.trim(),
    p_query_alt: transliterateQuery(value) ?? undefined,
    p_limit: CANDIDATE_LIMIT,
  });
  if (error) throw new Error("Department lookup failed.");
  return resolveRanked(data as RankedRow[] | null);
}

/**
 * Turns an unresolved filter into a clarification result the tool returns
 * instead of data. Guessing which "Dr. Ahmed" was meant would silently answer
 * about the wrong person, so the tool stops and asks.
 */
export function filterClarification(
  field: string,
  input: string,
  resolution: FilterResolution,
): { needs_clarification: true; field: string; guidance: string; candidates: unknown[] } | null {
  if (resolution.status === "ambiguous") {
    return {
      needs_clarification: true,
      field,
      guidance: `More than one ${field} matches "${input}". Show these candidates to the user and ask which one they mean before retrying. Do not choose one yourself.`,
      candidates: resolution.candidates,
    };
  }
  if (resolution.status === "not_found") {
    return {
      needs_clarification: true,
      field,
      guidance: `No active ${field} matches "${input}". Tell the user no match was found and ask them to confirm the name.`,
      candidates: [],
    };
  }
  return null;
}
