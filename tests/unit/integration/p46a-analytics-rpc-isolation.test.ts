import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";

// P4.6A aggregate-RPC isolation suite, run against live Postgres because the
// properties under test are database properties: the SECURITY DEFINER analytics
// RPCs must re-resolve the caller's clinic themselves (never trusting an
// argument), enforce the role matrix, and suppress small patient buckets. A
// mocked client cannot prove any of that.

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const publishableKey = required("LOCAL_SUPABASE_PUBLISHABLE_KEY");
const secretKey = required("LOCAL_SUPABASE_SECRET_KEY");
type Client = SupabaseClient<Database>;

const suffix = `p46a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const password = "P46aTest12345";
const clinicA = randomUUID();
const clinicB = randomUUID();
/** A clinic with no AI entitlement, for the M2 database-boundary test. */
const clinicBasic = randomUUID();
/**
 * A deliberately *asymmetric* clinic — 100 O+, 60 A+, 3 B+ — for review #2's H1.
 *
 * The other fixtures are all small enough that suppression covers every bucket,
 * which is exactly why the old assertions passed while the RPC was labelling a
 * 200-patient group "<5": under full suppression there is no visible bucket to
 * contradict anything. This shape is the one that actually distinguishes the
 * two suppression reasons — B+ is below the floor, A+ is pulled in only to
 * protect it, and O+ survives.
 */
const clinicSkew = randomUUID();
const departmentA = randomUUID();

const service = createClient<Database>(url, secretKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const userIds: string[] = [];

function client(): Client {
  return createClient<Database>(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(label: string) {
  const email = `${suffix}-${label}@example.com`;
  const created = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw created.error ?? new Error("no user");
  userIds.push(created.data.user.id);

  const signedIn = client();
  const auth = await signedIn.auth.signInWithPassword({ email, password });
  if (auth.error) throw auth.error;
  return { id: created.data.user.id, client: signedIn };
}

/** Deterministic patient rows so bucket sizes are exactly known. */
function patientRow(
  clinicId: string,
  createdBy: string,
  index: number,
  bloodType: "O+" | "A+" | "B+",
) {
  return {
    id: randomUUID(),
    clinic_id: clinicId,
    full_name: `P46A Patient ${index}`,
    date_of_birth: "1990-01-01",
    phone: `+9655000${String(index).padStart(4, "0")}`,
    email: `${suffix}-p${index}-${clinicId.slice(0, 8)}@example.com`,
    national_id: `${Date.now()}${index}${clinicId.slice(0, 4)}`,
    file_number: `${suffix}-${clinicId.slice(0, 4)}-${index}`,
    created_by: createdBy,
    blood_type: bloodType,
  };
}

let adminA: Client;
let managerA: Client;
let receptionistA: Client;
let assistantA: Client;
let adminB: Client;
let adminBasic: Client;
let adminSkew: Client;
let adminAId = "";
let adminBId = "";
let adminBasicId = "";
let managerAId = "";

const ALL_CLINICS = [clinicA, clinicB, clinicBasic, clinicSkew];

async function cleanup() {
  await service.from("user_ai_permissions").delete().in("clinic_id", ALL_CLINICS);
  await service.from("ai_commercial_terms").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinic_feature_overrides").delete().in("clinic_id", ALL_CLINICS);
  await service.from("subscriptions").delete().in("clinic_id", ALL_CLINICS);
  await service.from("patients").delete().in("clinic_id", ALL_CLINICS);
  await service.from("profiles").delete().in("clinic_id", ALL_CLINICS);
  await service.from("departments").delete().in("clinic_id", ALL_CLINICS);
  await service.from("clinics").delete().in("id", ALL_CLINICS);
}

beforeAll(async () => {
  const [a, m, r, assistant, b, basic, skew] = await Promise.all([
    createUser("admin-a"),
    createUser("manager-a"),
    createUser("receptionist-a"),
    createUser("assistant-a"),
    createUser("admin-b"),
    createUser("admin-basic"),
    createUser("admin-skew"),
  ]);
  adminA = a.client;
  managerA = m.client;
  receptionistA = r.client;
  assistantA = assistant.client;
  adminB = b.client;
  adminBasic = basic.client;
  adminSkew = skew.client;
  adminAId = a.id;
  adminBId = b.id;
  adminBasicId = basic.id;
  managerAId = m.id;

  await cleanup();

  const clinics = await service.from("clinics").insert([
    { id: clinicA, name: `P46A Clinic A ${suffix}` },
    { id: clinicB, name: `P46A Clinic B ${suffix}` },
    { id: clinicBasic, name: `P46A Clinic Basic ${suffix}` },
    { id: clinicSkew, name: `P46A Clinic Skew ${suffix}` },
  ]);
  if (clinics.error) throw clinics.error;

  // The analytics RPCs enforce the pro_ai AI entitlements in the database as of
  // the P4.6 phase-review fixes (M2), so the fixture has to say which plan each
  // clinic is on — previously no clinic here had a subscription at all, and the
  // guard did not care.
  const plans = await service
    .from("plans")
    .select("id, slug")
    .in("slug", ["basic", "pro_ai"]);
  if (plans.error) throw plans.error;
  const planBySlug = Object.fromEntries(plans.data.map((plan) => [plan.slug, plan.id]));

  const subscriptions = await service.from("subscriptions").insert([
    { clinic_id: clinicA, plan_id: planBySlug.pro_ai, status: "active" as const },
    { clinic_id: clinicB, plan_id: planBySlug.pro_ai, status: "active" as const },
    { clinic_id: clinicBasic, plan_id: planBySlug.basic, status: "active" as const },
    { clinic_id: clinicSkew, plan_id: planBySlug.pro_ai, status: "active" as const },
  ]);
  if (subscriptions.error) throw subscriptions.error;

  const departments = await service
    .from("departments")
    .insert([{ id: departmentA, clinic_id: clinicA, name: `P46A Dept ${suffix}` }]);
  if (departments.error) throw departments.error;

  const profiles = await service.from("profiles").insert([
    { id: a.id, clinic_id: clinicA, full_name: "P46A Admin A", role: "admin" },
    { id: m.id, clinic_id: clinicA, full_name: "P46A Manager A", role: "manager" },
    { id: r.id, clinic_id: clinicA, full_name: "P46A Receptionist A", role: "receptionist" },
    { id: assistant.id, clinic_id: clinicA, full_name: "P46A Assistant A", role: "assistant" },
    { id: b.id, clinic_id: clinicB, full_name: "P46A Admin B", role: "admin" },
    { id: basic.id, clinic_id: clinicBasic, full_name: "P46A Admin Basic", role: "admin" },
    { id: skew.id, clinic_id: clinicSkew, full_name: "P46A Admin Skew", role: "admin" },
  ]);
  if (profiles.error) throw profiles.error;

  const terms = await service.from("ai_commercial_terms").insert([
    { clinic_id: clinicA, change_reason: "pilot", updated_by: a.id, accepted_at: new Date().toISOString() },
    { clinic_id: clinicB, change_reason: "pilot", updated_by: b.id, accepted_at: new Date().toISOString() },
    { clinic_id: clinicSkew, change_reason: "pilot", updated_by: skew.id, accepted_at: new Date().toISOString() },
  ]);
  if (terms.error) throw terms.error;

  // Clinic A: 6 O+ patients (above the floor) and 2 A+ (below it).
  // Clinic B: 3 patients, which must never appear in clinic A's aggregates.
  const patients = await service.from("patients").insert([
    ...Array.from({ length: 6 }, (_, i) => patientRow(clinicA, adminAId, i, "O+")),
    ...Array.from({ length: 2 }, (_, i) => patientRow(clinicA, adminAId, 100 + i, "A+")),
    ...Array.from({ length: 3 }, (_, i) => patientRow(clinicB, adminBId, 200 + i, "O+")),
    // Clinic Skew: 100 / 60 / 3.
    ...Array.from({ length: 100 }, (_, i) => patientRow(clinicSkew, skew.id, 1000 + i, "O+")),
    ...Array.from({ length: 60 }, (_, i) => patientRow(clinicSkew, skew.id, 2000 + i, "A+")),
    ...Array.from({ length: 3 }, (_, i) => patientRow(clinicSkew, skew.id, 3000 + i, "B+")),
  ]);
  if (patients.error) throw patients.error;
}, 60_000);

afterAll(async () => {
  await cleanup();
  await Promise.all(userIds.map((id) => service.auth.admin.deleteUser(id)));
});

const RANGE = {
  p_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  p_end: new Date(Date.now() + 86_400_000).toISOString(),
};

describe("P4.6A aggregate RPC tenant isolation", () => {
  it("counts only the caller's own clinic", async () => {
    const a = await adminA.rpc("ai_get_clinic_summary", RANGE);
    const b = await adminB.rpc("ai_get_clinic_summary", RANGE);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();

    expect((a.data as { patients_total: number }).patients_total).toBe(8);
    expect((b.data as { patients_total: number }).patients_total).toBe(3);
  });

  it("never lets one clinic's directory leak into another's summary", async () => {
    const b = await adminB.rpc("ai_get_clinic_summary", RANGE);
    const serialized = JSON.stringify(b.data);
    expect(serialized).not.toContain("P46A Dept");
    expect(serialized).not.toContain("P46A Admin A");
    expect((b.data as { departments_active: number }).departments_active).toBe(0);
  });

  /**
   * Rewritten for review #2's H1.
   *
   * The previous version asserted only that the A+ bucket carried
   * `display: "<5"` against clinic A's 6 O+ / 2 A+ fixture. Under that fixture
   * complementary suppression hides O+ as well, so the assertion passed while
   * the whole distribution was hidden — it would have passed identically if
   * suppression hid everything unconditionally, and it did not notice that O+
   * was being labelled "<5" too. It now runs against the asymmetric clinic,
   * where a visible bucket survives and the two suppression reasons are
   * distinguishable.
   */
  it("generalizes every suppressed category into one unnamed aggregate", async () => {
    const result = await adminSkew.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    expect(result.error).toBeNull();

    const stats = result.data as PatientStats;
    expect(stats.suppression_floor).toBe(5);
    expect(stats.distribution_withheld).toBe(false);

    const bucket = (name: string) =>
      stats.buckets_all_time.find((candidate) => candidate.bucket === name);

    // O+ is untouched: suppression must not cost the whole distribution when
    // one rare category exists.
    expect(bucket("O+")).toMatchObject({ count: 100, suppressed: false });

    // A+ (60) and B+ (3) are folded together. Neither is named, so neither can
    // be sized — which is what makes the aggregate's exact count publishable.
    expect(bucket("A+")).toBeUndefined();
    expect(bucket("B+")).toBeUndefined();
    expect(bucket("Other")).toMatchObject({
      count: 63,
      display: "63",
      suppressed: true,
      suppression_reason: "aggregated",
      grouped_bucket_count: 2,
    });

    expect(stats.suppressed_bucket_count).toBe(2);
    expect(stats.suppressed_patient_count).toBe(63);
  });

  /**
   * H1 (review #3). The aggregate replaced the old per-bucket `<5` / `hidden`
   * labels, so neither vocabulary may reappear — each was a claim about an
   * individual category, and it is exactly such a claim, combined with an exact
   * total obtainable elsewhere, that made the old design reversible.
   */
  it("makes no numeric or size claim about any individual hidden category", async () => {
    const result = await adminSkew.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    const stats = result.data as PatientStats;
    const serialized = JSON.stringify(stats.buckets_all_time);

    expect(serialized).not.toContain("60");
    expect(serialized).not.toContain("<5");
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("below_floor");
    expect(serialized).not.toContain("complementary");
    expect(serialized).not.toContain("A+");
    expect(serialized).not.toContain("B+");
  });

  /**
   * The total is exact again, and that is a *property*, not an oversight: the
   * aggregate is published outright, so `patients_total` minus the visible
   * buckets yields a number the payload already states. Asserting it stays
   * exact also pins agreement with `ai_get_clinic_summary`, whose exact total
   * is what made the previous rounded design reversible.
   */
  it("publishes an exact total that reconciles with the aggregate", async () => {
    const result = await adminSkew.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    const stats = result.data as PatientStats;

    expect(stats.patients_total).toBe(163);
    expect(stats.patients_total_exact).toBe(true);

    const visibleSum = stats.buckets_all_time
      .filter((candidate) => !candidate.suppressed)
      .reduce((sum, candidate) => sum + (candidate.count ?? 0), 0);
    expect(stats.patients_total! - visibleSum).toBe(stats.suppressed_patient_count);
  });

  /**
   * The terminal case review #2 asked to decide. Clinic A's 6 O+ / 2 A+ leaves
   * nothing visible after complementary suppression, so the RPC declines the
   * grouping rather than emitting a list of nameless nulls that reads like data.
   */
  it("declines the grouping outright when nothing survives suppression", async () => {
    const result = await adminA.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    const stats = result.data as PatientStats;

    expect(stats.distribution_withheld).toBe(true);
    expect(stats.distribution_withheld_reason).toBe("all_buckets_suppressed");
    expect(stats.buckets_all_time).toEqual([]);
    // No bucket label survives either, so "this clinic has A+ patients" is not
    // published alongside an approximate total.
    expect(JSON.stringify(stats.buckets_all_time)).not.toContain("A+");
  });
});

type PatientStats = {
  suppression_floor: number;
  suppressed_bucket_count: number;
  suppressed_patient_count: number;
  patients_total: number | null;
  patients_total_exact: boolean;
  patients_new_in_range: number;
  bucket_scope: string;
  distribution_withheld: boolean;
  distribution_withheld_reason: string | null;
  buckets_all_time: {
    bucket: string;
    count: number | null;
    display: string;
    suppressed: boolean;
    suppression_reason: string | null;
    grouped_bucket_count: number | null;
  }[];
};

/**
 * H1 — the headline privacy control of the sub-phase. The original
 * implementation published the exact clinic total alongside a bucket set that
 * partitions it, so a lone suppressed cell was recoverable by subtraction: with
 * this fixture's 6 O+ and 2 A+ patients, `8 − 6 = 2` gave the suppressed count
 * exactly. These assert the arithmetic no longer closes, against real rows.
 */
describe("P4.6A small-cell suppression is not reversible", () => {
  async function stats(): Promise<PatientStats> {
    const result = await adminA.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    expect(result.error).toBeNull();
    return result.data as PatientStats;
  }

  it("never leaves a single solvable suppressed cell", async () => {
    const data = await stats();
    expect(data.suppressed_bucket_count).toBeGreaterThanOrEqual(2);
  });

  /**
   * Runs against the asymmetric clinic, because that is the only fixture in
   * this suite where a visible bucket exists to subtract *from*. On clinic A the
   * property holds vacuously — nothing is visible, so no subtraction is even
   * expressible, which is a weaker statement than the one this test names.
   */
  it("leaves a residual too large and too spread out to identify anyone", async () => {
    const result = await adminSkew.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    const data = result.data as PatientStats;
    const visible = data.buckets_all_time.filter((bucket) => !bucket.suppressed);
    const suppressed = data.buckets_all_time.filter((bucket) => bucket.suppressed);

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((bucket) => bucket.count !== null)).toBe(true);
    // Exactly one aggregate, covering at least two categories and at least a
    // floor's worth of patients. Both bounds come from the complementary loop,
    // and both are what make publishing its exact count safe.
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].grouped_bucket_count).toBeGreaterThanOrEqual(2);
    expect(data.suppressed_patient_count).toBeGreaterThanOrEqual(data.suppression_floor);
  });

  /**
   * H1 (review #3) — the regression test the previous two cycles lacked.
   *
   * Every earlier suppression assertion read `ai_get_patient_stats` in
   * isolation, which is the scope at which the old property was true and
   * insufficient. The RPC withheld the exact total so the suppressed residual
   * could not be recovered by subtraction — but `ai_get_clinic_summary` mounts
   * under identical `roles` and `requiredFeatures`, is callable in the same
   * turn, and published that same total exactly. Two calls and one subtraction
   * recovered both hidden cells of a 100 / 4 / 3 clinic.
   *
   * The invariant this pins is therefore deliberately stated over the *pair*:
   * no two tools available to the same caller may jointly determine anything
   * the distribution declined to publish. It is expressed as "the subtraction
   * still closes, and yields only the figure the payload already states".
   */
  it("is not reversible by combining the two tools a caller always holds", async () => {
    const [statsResult, summaryResult] = await Promise.all([
      adminSkew.rpc("ai_get_patient_stats", { ...RANGE, p_group_by: "blood_type" }),
      adminSkew.rpc("ai_get_clinic_summary", RANGE),
    ]);
    expect(statsResult.error).toBeNull();
    expect(summaryResult.error).toBeNull();

    const data = statsResult.data as PatientStats;
    const summaryTotal = (summaryResult.data as { patients_total: number }).patients_total;

    // The two tools must agree. Disagreement is what the old design relied on,
    // and it read as a broken product to anyone who noticed.
    expect(summaryTotal).toBe(data.patients_total);

    const visibleSum = data.buckets_all_time
      .filter((bucket) => !bucket.suppressed)
      .reduce((sum, bucket) => sum + (bucket.count ?? 0), 0);

    // The attacker's arithmetic, performed exactly as review #3 performed it.
    const recovered = summaryTotal - visibleSum;

    // It yields the aggregate the payload publishes outright — nothing more.
    expect(recovered).toBe(data.suppressed_patient_count);
    // And the aggregate cannot be decomposed: it spans >= 2 unnamed categories,
    // so no single category's count follows from it.
    expect(data.suppressed_bucket_count).toBeGreaterThanOrEqual(2);
    expect(recovered).toBeGreaterThanOrEqual(data.suppression_floor);
  });

  /**
   * The second vector, inside this tool's own payload. `patients_new_in_range`
   * is an exact unsuppressed count over the same table, so when the range
   * covers the clinic's history it equals the total. That is now harmless for
   * the same reason the sibling total is — but it is asserted so a future change
   * that reintroduces a withheld total also has to reckon with this field.
   */
  it("survives patients_new_in_range equalling the total", async () => {
    const result = await adminSkew.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    const data = result.data as PatientStats;
    const visibleSum = data.buckets_all_time
      .filter((bucket) => !bucket.suppressed)
      .reduce((sum, bucket) => sum + (bucket.count ?? 0), 0);

    expect(data.patients_new_in_range).toBe(data.patients_total);
    expect(data.patients_new_in_range - visibleSum).toBe(data.suppressed_patient_count);
  });

  it("names the buckets for the population they actually describe (L7)", async () => {
    const data = await stats();
    // patients_total and the buckets are all-time; only patients_new_in_range
    // respects p_start/p_end. The field name has to say so.
    expect(data.bucket_scope).toBe("all_time");
    expect((data as unknown as { buckets?: unknown }).buckets).toBeUndefined();
  });

  it("returns exact counts when nothing needs suppressing", async () => {
    // Clinic B's three O+ patients form one bucket below the floor, so this
    // asserts the complementary rule cannot be escaped by having one group.
    const result = await adminB.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "blood_type",
    });
    const data = result.data as PatientStats;
    // Everything was suppressed, so the grouping is declined rather than
    // returned as a list of hidden cells (review #2, H1) or as a lone aggregate
    // equal to the total, which would say nothing the total does not.
    expect(data.distribution_withheld).toBe(true);
    expect(data.buckets_all_time).toEqual([]);
    // The total stays exact even here (review #3, M1): rounding it produced
    // `patients_total_approx: 0` for a clinic with two patients.
    expect(data.patients_total_exact).toBe(true);
    expect(data.patients_total).toBe(3);
  });

  it("no longer exposes the per-cell helper that made a reversible result look safe", async () => {
    const result = await service.rpc(
      "ai_suppress_small_cell" as never,
      { p_count: 2 } as never,
    );
    expect(result.error).not.toBeNull();
  });
});

/**
 * H2 — the SQL guard is the third layer. It previously raised only for doctors
 * (and for receptionists on financial reads), so for the clinic-wide aggregates
 * the application registry was the sole thing denying receptionists.
 */
describe("P4.6A clinic-analytics scope denies receptionists at the database boundary", () => {
  it.each(["ai_get_clinic_summary", "ai_get_patient_stats", "ai_get_appointment_stats"] as const)(
    "refuses a receptionist calling %s",
    async (fn) => {
      const args =
        fn === "ai_get_clinic_summary" ? RANGE : { ...RANGE, p_group_by: "status" };
      const result = await receptionistA.rpc(fn as never, args as never);
      expect(result.error).not.toBeNull();
      expect(result.error?.message).toContain("Not authorized for clinic analytics");
    },
  );

  it("still allows a receptionist the operational scope", async () => {
    const result = await receptionistA.rpc("ai_assert_analytics_caller" as never, {
      p_scope: "operational",
    } as never);
    expect(result.error).toBeNull();
    expect(result.data).toBe(clinicA);
  });

  it("refuses an unsupported scope rather than defaulting to the loosest one", async () => {
    const result = await adminA.rpc("ai_assert_analytics_caller" as never, {
      p_scope: "everything",
    } as never);
    expect(result.error).not.toBeNull();
  });

  it("keeps admins and managers on the clinic-analytics scope", async () => {
    for (const client of [adminA, managerA]) {
      const result = await client.rpc("ai_get_patient_stats", {
        ...RANGE,
        p_group_by: "department",
      });
      expect(result.error).toBeNull();
    }
  });
});

/**
 * H3 — the cross-tenant primary-key squat. An admin of clinic B could insert a
 * row naming a clinic-A user with `clinic_id = B`: the `with check` passed, and
 * the global `(user_id, permission_key)` key was then taken, so clinic A's own
 * admin could never upsert the real grant.
 */
describe("P4.6A user_ai_permissions cross-tenant integrity", () => {
  it("rejects a row whose clinic_id is not the target user's clinic", async () => {
    // Written with the service client, which bypasses RLS entirely — so this
    // proves the *constraint* holds, not merely that a policy would have caught
    // it. A defect that only RLS prevents is one bad policy edit from returning.
    const result = await service.from("user_ai_permissions").insert({
      user_id: managerAId,
      clinic_id: clinicB,
      permission_key: "ai.financial_insights",
      granted: true,
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe("23503");
  });

  it("accepts the same grant when the clinic matches", async () => {
    const insert = await service.from("user_ai_permissions").insert({
      user_id: managerAId,
      clinic_id: clinicA,
      permission_key: "ai.financial_insights",
      granted: true,
    });
    expect(insert.error).toBeNull();

    const read = await managerA
      .from("user_ai_permissions")
      .select("granted")
      .eq("user_id", managerAId)
      .maybeSingle();
    expect(read.data?.granted).toBe(true);

    await service
      .from("user_ai_permissions")
      .delete()
      .eq("user_id", managerAId)
      .eq("clinic_id", clinicA);
  });

  it("lets clinic B's admin be refused by policy as well as by constraint", async () => {
    const result = await adminB.from("user_ai_permissions").insert({
      user_id: managerAId,
      clinic_id: clinicB,
      permission_key: "ai.financial_insights",
      granted: true,
    });
    expect(result.error).not.toBeNull();
  });

  it("keeps the key set closed so a typo cannot create an inert grant", async () => {
    const result = await service.from("user_ai_permissions").insert({
      user_id: managerAId,
      clinic_id: clinicA,
      permission_key: "ai.financial_insight",
      granted: true,
    } as never);
    expect(result.error).not.toBeNull();
  });
});

describe("P4.6A aggregate RPC role matrix", () => {
  it("allows a manager operational aggregates", async () => {
    const result = await managerA.rpc("ai_get_appointment_stats", {
      ...RANGE,
      p_group_by: "status",
    });
    expect(result.error).toBeNull();
    expect((result.data as { total: number }).total).toBe(0);
  });

  it("refuses a receptionist the financial aggregate at the database boundary", async () => {
    const result = await receptionistA.rpc("ai_get_revenue_summary", RANGE);
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("Not authorized for financial analytics");
  });

  it("refuses assistants every clinic-wide analytics scope at the database boundary", async () => {
    for (const p_scope of [
      "operational",
      "clinic_analytics",
      "financial",
    ] as const) {
      const result = await assistantA.rpc(
        "ai_assert_analytics_caller" as never,
        { p_scope } as never,
      );
      expect(result.error?.code).toBe("42501");
    }
  });

  it("refuses an unsupported grouping instead of silently defaulting", async () => {
    const result = await adminA.rpc("ai_get_patient_stats", {
      ...RANGE,
      p_group_by: "national_id",
    });
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toContain("Unsupported grouping");
  });

  it("refuses an unauthenticated caller", async () => {
    const result = await client().rpc("ai_get_clinic_summary", RANGE);
    expect(result.error).not.toBeNull();
  });
});

describe("P4.6A ranked entity search", () => {
  it("scopes staff search to the caller's clinic", async () => {
    const a = await adminA.rpc("search_staff_ranked", { p_query: "P46A Admin", p_limit: 10 });
    expect(a.error).toBeNull();
    const names = (a.data ?? []).map((row) => row.full_name);
    expect(names).toContain("P46A Admin A");
    expect(names).not.toContain("P46A Admin B");
  });

  it("filters staff search by role", async () => {
    const result = await adminA.rpc("search_staff_ranked", {
      p_query: "P46A",
      p_role: "manager",
      p_limit: 10,
    });
    expect(result.error).toBeNull();
    expect((result.data ?? []).every((row) => row.role === "manager")).toBe(true);
  });

  it("scopes department search to the caller's clinic", async () => {
    const b = await adminB.rpc("search_departments_ranked", {
      p_query: "P46A Dept",
      p_limit: 10,
    });
    expect(b.error).toBeNull();
    expect(b.data ?? []).toEqual([]);
  });
});

/**
 * M1 and M2 of `docs/reviews/P4.6_PHASE_REVIEW.md`.
 *
 * These run against live Postgres over PostgREST with an ordinary signed-in
 * user's token — the exact path the review identified — because the property
 * under test is that the *database* refuses, with the application removed from
 * the picture entirely. Every assertion here would have passed vacuously before
 * `20260720150000`, since the guard checked role and nothing else.
 */
describe("M1 — the per-user financial grant exists at the database boundary", () => {
  async function setGrant(granted: boolean | null) {
    if (granted === null) {
      await service
        .from("user_ai_permissions")
        .delete()
        .eq("user_id", managerAId)
        .eq("clinic_id", clinicA);
      return;
    }
    const result = await service.from("user_ai_permissions").upsert(
      {
        user_id: managerAId,
        clinic_id: clinicA,
        permission_key: "ai.financial_insights",
        granted,
      },
      { onConflict: "clinic_id,user_id,permission_key" },
    );
    if (result.error) throw result.error;
  }

  const RANGE_ARGS = { p_start: RANGE.p_start, p_end: RANGE.p_end };

  it("refuses a manager with no grant row at all", async () => {
    await setGrant(null);
    const result = await managerA.rpc("ai_get_revenue_summary", RANGE_ARGS);
    expect(result.error?.code).toBe("42501");
  });

  it("refuses a manager whose grant is explicitly revoked", async () => {
    await setGrant(false);
    const result = await managerA.rpc("ai_get_revenue_summary", RANGE_ARGS);
    expect(result.error?.code).toBe("42501");
  });

  it("allows the same manager once an admin grants it", async () => {
    await setGrant(true);
    const result = await managerA.rpc("ai_get_revenue_summary", RANGE_ARGS);
    expect(result.error).toBeNull();
    expect(result.data).toBeTruthy();
  });

  it("applies the same gate to the period comparison", async () => {
    await setGrant(false);
    const result = await managerA.rpc("ai_compare_revenue_periods", {
      p_a_start: RANGE.p_start,
      p_a_end: RANGE.p_end,
      p_b_start: RANGE.p_start,
      p_b_end: RANGE.p_end,
    });
    expect(result.error?.code).toBe("42501");
  });

  it("never requires an explicit grant from an admin, who holds it implicitly", async () => {
    const result = await adminA.rpc("ai_get_revenue_summary", RANGE_ARGS);
    expect(result.error).toBeNull();
  });

  it("ignores a grant row written against another clinic", async () => {
    // The composite FK makes the cross-tenant row unwritable in the first
    // place; this asserts the guard would not honor one regardless, since it
    // filters on the caller's own re-resolved clinic.
    await setGrant(null);
    const squat = await service.from("user_ai_permissions").insert({
      user_id: managerAId,
      clinic_id: clinicB,
      permission_key: "ai.financial_insights",
      granted: true,
    });
    expect(squat.error).not.toBeNull();

    const result = await managerA.rpc("ai_get_revenue_summary", RANGE_ARGS);
    expect(result.error?.code).toBe("42501");
  });
});

describe("M2 — feature and terms entitlement exists at the database boundary", () => {
  const RANGE_ARGS = { p_start: RANGE.p_start, p_end: RANGE.p_end };

  it("refuses a basic-plan admin the clinic summary", async () => {
    const result = await adminBasic.rpc("ai_get_clinic_summary", RANGE_ARGS);
    expect(result.error?.code).toBe("42501");
  });

  it("refuses a basic-plan admin the patient attribute distribution", async () => {
    // The payload with a privacy class of its own — a blood-type distribution
    // is the one thing here worth gating even from a role that could compute it.
    const result = await adminBasic.rpc("ai_get_patient_stats", {
      ...RANGE_ARGS,
      p_group_by: "blood_type",
    });
    expect(result.error?.code).toBe("42501");
  });

  it("refuses a basic-plan admin appointment statistics", async () => {
    const result = await adminBasic.rpc("ai_get_appointment_stats", {
      ...RANGE_ARGS,
      p_group_by: "status",
    });
    expect(result.error?.code).toBe("42501");
  });

  it("refuses a basic-plan admin the revenue aggregate", async () => {
    const result = await adminBasic.rpc("ai_get_revenue_summary", RANGE_ARGS);
    expect(result.error?.code).toBe("42501");
  });

  it("allows an entitled admin everything the matrix permits", async () => {
    const result = await adminA.rpc("ai_get_clinic_summary", RANGE_ARGS);
    expect(result.error).toBeNull();
  });

  it("allows a Basic admin after umbrella and analytics overrides plus accepted terms", async () => {
    const overrides = await service.from("clinic_feature_overrides").insert([
      {
        clinic_id: clinicBasic,
        feature_key: "ai_assistant",
        enabled: true,
        updated_by: adminBasicId,
      },
      {
        clinic_id: clinicBasic,
        feature_key: "ai.staff_analytics",
        enabled: true,
        updated_by: adminBasicId,
      },
    ]);
    if (overrides.error) throw overrides.error;
    const terms = await service.from("ai_commercial_terms").insert({
      clinic_id: clinicBasic,
      change_reason: "pilot",
      updated_by: adminBasicId,
      accepted_at: new Date().toISOString(),
    });
    if (terms.error) throw terms.error;

    try {
      const result = await adminBasic.rpc("ai_get_clinic_summary", RANGE_ARGS);
      expect(result.error).toBeNull();
    } finally {
      await service.from("ai_commercial_terms").delete().eq("clinic_id", clinicBasic);
      await service.from("clinic_feature_overrides").delete().eq("clinic_id", clinicBasic);
    }
  });
});

/**
 * L1 — the `%` / `<%` prefilter in `search_patients_ranked` is asserted to be
 * *provably equivalent* to the `>= 0.18` score filter, which is what makes it a
 * legitimate index optimization rather than a silent narrowing of results. The
 * argument holds branch-by-branch on inspection, but it depends on pg_trgm's
 * operators comparing `>=` rather than `>` against the threshold, on the `SET`s
 * applying inside the CTE, and on nobody later lowering the floor or changing
 * the operators without changing both sides. None of that was pinned.
 *
 * The full row-for-row equivalence was also verified directly in SQL over a
 * 20,400-row corpus across eight query shapes (0 rows missing, 0 extra) — see
 * the evidence table in `docs/reports/P4_6_PHASE_REVIEW_FIXES.md`. That check
 * cannot live here without adding a test-only function to a production
 * migration, so what runs here is the observable half: fuzzy variants that must
 * survive the prefilter, and the guarantee that nothing below the floor slips
 * through it.
 */
describe("L1 — the sargable prefilter neither narrows nor widens the result set", () => {
  // Misspellings only — each of these reaches the score branch and nothing
  // else, so a narrowed prefilter would return no rows at all for them. A
  // case-only variant is deliberately excluded: it resolves as `name_prefix`,
  // which would pass this assertion without exercising the branch under test.
  const FUZZY_VARIANTS = [
    "P46A Patinet",  // transposition
    "P46A Ptient",   // deletion
    "P46A Pattient", // insertion
  ];

  it("still finds patients through the fuzzy branch, not only exact or prefix", async () => {
    for (const query of FUZZY_VARIANTS) {
      const result = await adminA.rpc("search_patients_ranked", {
        p_query: query,
        p_limit: 100,
      });
      expect(result.error).toBeNull();

      const fuzzy = (result.data ?? []).filter((row) => row.match_kind === "name_fuzzy");
      // If the prefilter narrowed, the misspellings would return nothing at all
      // — the whole point of the branch is that it survives a bad spelling.
      expect(fuzzy.length).toBeGreaterThan(0);
    }
  });

  it("normalizes case through the prefix branch rather than losing the match", async () => {
    const result = await adminA.rpc("search_patients_ranked", {
      p_query: "p46a patient",
      p_limit: 100,
    });
    expect(result.error).toBeNull();
    expect((result.data ?? []).length).toBeGreaterThan(0);
    expect((result.data ?? []).every((row) => row.match_kind === "name_prefix")).toBe(true);
  });

  it("never returns a row below the recall floor through the fuzzy branch", async () => {
    for (const query of [...FUZZY_VARIANTS, "zzzzzzzz", "a"]) {
      const result = await adminA.rpc("search_patients_ranked", {
        p_query: query,
        p_limit: 100,
      });
      expect(result.error).toBeNull();

      for (const row of result.data ?? []) {
        if (row.match_kind !== "name_fuzzy") continue;
        // A widened prefilter would surface rows the score filter rejects.
        expect(row.score).toBeGreaterThanOrEqual(0.18);
      }
    }
  });

  it("returns nothing for a query that matches nothing, rather than everything", async () => {
    const result = await adminA.rpc("search_patients_ranked", {
      p_query: "qqqqxxxxzzzz",
      p_limit: 100,
    });
    expect(result.error).toBeNull();
    expect(result.data ?? []).toEqual([]);
  });
});

/**
 * L13 — an 8-digit phone suffix scores 1.0, so two patients holding the same
 * national number under different country codes both look certain. The outcome
 * is safe because `classifyConfidence` requires a lead as well as a score, but
 * the score itself overclaims, and a future consumer reading it directly would
 * be misled. This pins the safe outcome so a change to either side is visible.
 */
describe("L13 — a tied phone-suffix match forces a clarification", () => {
  it("scores both country-code variants 1.0 and leads with neither", async () => {
    const shared = "55007777";
    const rows = await service.from("patients").insert([
      {
        id: randomUUID(),
        clinic_id: clinicA,
        full_name: "P46A Phone Kuwait",
        date_of_birth: "1990-01-01",
        phone: `+965${shared}`,
        email: `${suffix}-kw@example.com`,
        national_id: `${Date.now()}kw`,
        file_number: `${suffix}-kw`,
        created_by: adminAId,
      },
      {
        id: randomUUID(),
        clinic_id: clinicA,
        full_name: "P46A Phone Saudi",
        date_of_birth: "1990-01-01",
        phone: `+966${shared}`,
        email: `${suffix}-sa@example.com`,
        national_id: `${Date.now()}sa`,
        file_number: `${suffix}-sa`,
        created_by: adminAId,
      },
    ]);
    if (rows.error) throw rows.error;

    const result = await adminA.rpc("search_patients_ranked", {
      p_query: shared,
      p_limit: 10,
    });
    expect(result.error).toBeNull();

    const matches = (result.data ?? []).filter((row) => row.match_kind === "phone");
    expect(matches).toHaveLength(2);
    expect(matches.every((row) => row.score === 1)).toBe(true);

    const { classifyConfidence } = await import("@/lib/ai/entity-search");
    // Tied 1.0 scores give no lead, so the contract is "ask", never "assume".
    expect(classifyConfidence(matches.map((row) => row.score))).not.toBe("high");
  });
});
