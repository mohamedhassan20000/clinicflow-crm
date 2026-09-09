/**
 * The clinic's package and insurance catalogs, as data and as a matcher.
 *
 * Split out of `tools.ts` because it is **pure**: there is no `server-only`
 * import, no database client and no clock in this file, only the shapes the
 * reads return and the two functions that decide whether a name the patient
 * typed is one of them. That is not tidiness — a flow test that stubs the tool
 * layer at the module boundary (which every V2 behaviour test does) would
 * otherwise stub the resolvers away too, and the matching a package or an
 * insurer question turns on would be untested at the point it is used.
 *
 * The reads that produce these shapes stay in `tools.ts`, which re-exports the
 * types so nothing downstream has to know about the split.
 */

import { resolveNamedEntity } from "@/lib/ai/entity-resolution";

export type InsuranceProvider = {
  readonly id: string;
  /** The label the patient reads, localized to the turn. */
  readonly label: string;
  /** Canonical + both authored names, for matching. Never rendered. */
  readonly aliases: readonly string[];
};

/**
 * One named insurer, checked against the clinic's own configured list.
 *
 * ## Why this is a resolution and not a search
 *
 * «بتقبلوا أكسا؟» is a yes/no about *this clinic's* configuration, and the only
 * two honest answers are "yes, and here is the stored name" and "no, and here
 * is what we do accept". Everything about the shape below follows from that:
 *
 *   * the candidate set is the clinic's own active providers and nothing else,
 *     so this can never become an existence oracle across clinics or a general
 *     knowledge lookup;
 *   * a deactivated or soft-deleted insurer is not in the set at all, so it can
 *     neither be confirmed nor named in the "we don't take that" list;
 *   * matching runs over the *aliases* — canonical plus both authored names —
 *     so «أكسا» and "AXA" resolve to the same row whichever the clinic typed,
 *     using the same fuzzy resolver departments use. Fuzzy is correct here in a
 *     way it never is for a patient record: nothing about a company name is
 *     identity-shaped.
 *
 * Coverage is deliberately not modelled. ClinicFlow stores *which insurers the
 * clinic works with*, not which services are covered under which policy, so the
 * copy this feeds says the first and never implies the second.
 */
export function resolveInsuranceProvider(input: {
  providers: readonly InsuranceProvider[];
  spoken: string;
}):
  | { kind: "matched"; provider: InsuranceProvider }
  | { kind: "ambiguous"; candidates: readonly InsuranceProvider[] }
  | { kind: "none" } {
  // One entity per provider, with the clinic's other authored names as
  // `aliases`. `resolveNamedEntity` scores every alias and keeps the entity's
  // best — so «أكسا» and "AXA" reach the same row, and an alias can never split
  // one insurer into two candidates.
  const byId = new Map(input.providers.map((provider) => [provider.id, provider]));
  const resolution = resolveNamedEntity(
    input.spoken,
    input.providers.map((provider) => ({
      id: provider.id,
      name: provider.label,
      aliases: provider.aliases,
    })),
  );
  if (resolution.status === "resolved") {
    const provider = byId.get(resolution.entity.id);
    return provider ? { kind: "matched", provider } : { kind: "none" };
  }
  if (resolution.status === "ambiguous") {
    const candidates = resolution.candidates
      .map((candidate) => byId.get(candidate.id))
      .filter((provider): provider is InsuranceProvider => provider !== undefined);
    if (candidates.length === 1) return { kind: "matched", provider: candidates[0]! };
    return { kind: "ambiguous", candidates };
  }
  return { kind: "none" };
}

export type PackageGroup = {
  readonly departmentId: string;
  readonly departmentName: string;
  readonly packages: readonly PackageEntry[];
};

export type PackageItemEntry = {
  readonly serviceId: string;
  /** The service's localized name, from the clinic's own authored names. */
  readonly serviceName: string;
  readonly sessions: number;
  /** The clinic's package price per session. Stored, never derived. */
  readonly pricePerSession: number;
  /** sessions x pricePerSession. */
  readonly subtotal: number;
  /** The service's current catalogue price, for reference only. */
  readonly serviceRegularPrice: number | null;
};

export type PackageEntry = {
  readonly id: string;
  /** The label the patient reads, localized to the turn. */
  readonly name: string;
  /** Canonical + both authored names, for matching. Never rendered. */
  readonly aliases: readonly string[];
  readonly departmentId: string;
  readonly departmentName: string;
  readonly totalSessions: number;
  readonly pricePerSession: number | null;
  readonly totalPrice: number | null;
  /**
   * The services this package contains, in the clinic's own order.
   *
   * Empty for a department-only package — the legacy shape, every package that
   * exists before the item table does, and a permanently supported one — which
   * renders exactly as it does today. One entry for a single-service package,
   * several for a basket.
   *
   * Every number here is *stored*: `pricePerSession` is the price the clinic
   * agreed for this service inside this package, not the catalogue price, and
   * `subtotal` is `sessions x pricePerSession` and nothing cleverer.
   * `serviceRegularPrice` is the service's current catalogue price, carried for
   * reference alone — nothing derives a saving from the pair, because a
   * "saving" is arithmetic on two numbers whose relationship only the clinic
   * knows, and a package priced above a service's list price is a perfectly
   * ordinary thing for a clinic to sell.
   */
  readonly items: readonly PackageItemEntry[];
  /** The clinic's own note on the package, verbatim. Never generated. */
  readonly notes: string | null;
};

/**
 * One named package, resolved against this clinic's own catalog.
 *
 * The same discipline {@link resolveInsuranceProvider} follows and for the same
 * reasons: the candidate set is the clinic's active templates, matching runs
 * over canonical plus both authored names so «باكيدج التأهيل» and
 * "Rehabilitation Package" reach the same row, and a name that matches nothing
 * is `none` — never a package described from its words.
 */
export function resolvePackageNamed(input: {
  packages: readonly PackageEntry[];
  spoken: string;
}):
  | { kind: "matched"; entry: PackageEntry }
  | { kind: "ambiguous"; candidates: readonly PackageEntry[] }
  | { kind: "none" } {
  const byId = new Map(input.packages.map((entry) => [entry.id, entry]));
  const resolution = resolveNamedEntity(
    input.spoken,
    input.packages.map((entry) => ({
      id: entry.id,
      name: entry.name,
      aliases: entry.aliases,
    })),
  );
  if (resolution.status === "resolved") {
    const entry = byId.get(resolution.entity.id);
    return entry ? { kind: "matched", entry } : { kind: "none" };
  }
  if (resolution.status === "ambiguous") {
    const candidates = resolution.candidates
      .map((candidate) => byId.get(candidate.id))
      .filter((entry): entry is PackageEntry => entry !== undefined);
    if (candidates.length === 1) return { kind: "matched", entry: candidates[0]! };
    return { kind: "ambiguous", candidates };
  }
  return { kind: "none" };
}
