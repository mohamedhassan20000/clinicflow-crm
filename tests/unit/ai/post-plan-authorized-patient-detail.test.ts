import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

/**
 * Post-plan product completion — change 1: authorized patient-detail retrieval.
 *
 * The regression these tests pin is *not* an authorization hole. It is the
 * opposite: the assistant reported that authorized information "cannot be
 * shown", because `get_patient_stats`' k-anonymity was the only distribution
 * path and its suppression language had generalized into a blanket refusal.
 *
 * Every assertion here therefore has a matching negative: the grouped path is
 * exact and unsuppressed *and* it is still compiled through the same registered
 * filters, the same `assertResourceAccess` gates, the same RLS client and the
 * same tenant predicate as every other read. The statistical tool's own
 * suppression is deliberately left untouched.
 */

type Role = "admin" | "manager" | "receptionist" | "doctor" | "assistant";

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPARTMENT = "22222222-2222-4222-8222-222222222222";
const DOCTOR = "44444444-4444-4444-8444-444444444444";

function actor(role: Role) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    email: "resource@example.test",
    role,
    fullName: "Resource User",
    avatarUrl: null,
    clinicId: CLINIC,
    departmentId: role === "doctor" ? DEPARTMENT : null,
    mustChangePassword: false,
  };
}

async function load(
  role: Role,
  options: { readFeature?: boolean; clinicalFeature?: boolean } = {},
) {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("server-only", () => ({}));
  vi.doMock("@sentry/nextjs", () => ({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", () => ({
    logAgentToolCall: vi.fn(async () => ({ data: "audit", error: null })),
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      clinicId: CLINIC,
      planSlug: "pro_ai",
      features: {
        ai_assistant: true,
        "ai.read_operational": options.readFeature !== false,
        "ai.read_clinical": options.clinicalFeature !== false,
        "ai.staff_analytics": true,
        "ai.bulk_export": false,
      },
      limits: {},
      subscriptionAllowed: true,
      aiTermsAccepted: true,
    })),
    hasFeature: (
      entitlements: { features: Record<string, boolean> },
      key: string,
    ) => entitlements.features[key] === true,
  }));
  vi.doMock("@/lib/ai/permissions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/ai/permissions")>()),
    hasAiUserPermission: vi.fn(async () => false),
  }));

  const compile = await import("@/lib/ai/resources/compile");
  const toolsModule = await import("@/lib/ai/tools");
  const context = { user: actor(role), locale: "en" as const };
  return {
    compile,
    mocks,
    context,
    tools: await toolsModule.buildStaffTools(context),
  };
}

/** Sequential `patients` results: one per bucket count, then the grand total. */
function bucketCounts(counts: readonly number[]) {
  return counts.map((count) => ({ data: [], error: null, count }));
}

const opts = {} as never;

describe("grouped counts over the authorized resource path", () => {
  it("returns an exact, unsuppressed blood-type distribution for an admin", async () => {
    const { compile, mocks, context } = await load("admin");
    // 8 enum buckets + the null bucket + the grand total.
    mocks.state.tableResults.patients = bucketCounts([
      12, 3, 7, 0, 1, 0, 40, 9, 2, 74,
    ]);

    const result = await compile.groupedCountResource(
      context.user,
      "patients",
      "blood_type",
    );

    expect(result.metric).toBe("count");
    expect(result.group_by).toBe("blood_type");
    expect(result.suppressed).toBe(false);
    expect(result.total).toBe(74);
    // Sorted by size, zero buckets dropped, and — crucially — a bucket of 1 is
    // reported exactly rather than folded into an "Other" group.
    expect(result.groups).toEqual([
      { key: "O+", label: "O+", count: 40 },
      { key: "A+", label: "A+", count: 12 },
      { key: "O-", label: "O-", count: 9 },
      { key: "B+", label: "B+", count: 7 },
      { key: "A-", label: "A-", count: 3 },
      { key: null, label: "(none)", count: 2 },
      { key: "AB+", label: "AB+", count: 1 },
    ]);
    expect(result.empty_groups_omitted).toBe(2);
    expect(result.notice).toBeNull();
  });

  it("compiles every bucket through the registered filter, tenant predicate and base filters", async () => {
    const { compile, mocks, context } = await load("admin");
    mocks.state.tableResults.patients = bucketCounts([5, 0, 0, 0, 0, 0, 0, 0, 0, 5]);

    await compile.groupedCountResource(context.user, "patients", "blood_type");

    const patientFilters = mocks.state.queryLog.filter(
      (entry) => entry.table === "patients",
    );
    // Tenant predicate on every bucket query, never a model-supplied clinic id.
    expect(
      patientFilters.filter(
        (entry) => entry.args[0] === "eq" && entry.args[1] === "clinic_id",
      ).length,
    ).toBeGreaterThanOrEqual(10);
    expect(
      patientFilters.some(
        (entry) =>
          entry.args[0] === "eq" &&
          entry.args[1] === "blood_type" &&
          entry.args[2] === "O+",
      ),
    ).toBe(true);
    // The soft-delete base filters still apply to every bucket.
    expect(
      patientFilters.some(
        (entry) => entry.args[0] === "eq" && entry.args[1] === "is_deleted",
      ),
    ).toBe(true);
  });

  it("reconciles honestly when buckets do not account for the total", async () => {
    const { compile, mocks, context } = await load("admin");
    mocks.state.tableResults.patients = bucketCounts([
      2, 0, 0, 0, 0, 0, 0, 0, 0, 9,
    ]);
    const result = await compile.groupedCountResource(
      context.user,
      "patients",
      "blood_type",
    );
    expect(result.total).toBe(9);
    expect(result.notice).toBe(
      "7 of 9 record(s) fall outside the listed groups.",
    );
  });

  it("derives lookup-backed buckets through the referenced resource's own gates", async () => {
    const { compile, mocks, context } = await load("admin");
    mocks.state.tableResults.departments = {
      data: [
        { id: DEPARTMENT, name: "Dermatology" },
        { id: DOCTOR, name: "Cardiology" },
      ],
      error: null,
      count: 2,
    };
    mocks.state.tableResults.patients = bucketCounts([6, 4, 1, 11]);

    const result = await compile.groupedCountResource(
      context.user,
      "patients",
      "department_id",
    );

    expect(result.groups).toEqual([
      { key: DEPARTMENT, label: "Dermatology", count: 6 },
      { key: DOCTOR, label: "Cardiology", count: 4 },
      { key: null, label: "(none)", count: 1 },
    ]);
    // The bucket domain came from a real `departments` read, so a caller the
    // departments resource refuses cannot enumerate department buckets either.
    expect(
      mocks.state.queryLog.some((entry) => entry.table === "departments"),
    ).toBe(true);
  });

  it("rejects an unregistered group key with the valid list", async () => {
    const { compile, context } = await load("admin");
    await expect(
      compile.groupedCountResource(context.user, "patients", "national_id"),
    ).rejects.toMatchObject({
      reason: "invalid_aggregate",
      details: {
        valid_group_by: ["blood_type", "department_id", "assigned_doctor_id"],
      },
    });
  });

  it("refuses to group by a key the same call also filters on", async () => {
    const { compile, context } = await load("admin");
    await expect(
      compile.groupedCountResource(context.user, "patients", "blood_type", {
        filters: { blood_type: "O+" },
      }),
    ).rejects.toMatchObject({ reason: "invalid_aggregate" });
  });

  it("refuses a domain wider than the bucket ceiling instead of reporting a partial distribution", async () => {
    const { compile, mocks, context } = await load("admin");
    mocks.state.tableResults.departments = {
      data: Array.from({ length: compile.MAX_GROUP_BUCKETS + 1 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: `Department ${index}`,
      })),
      error: null,
      count: compile.MAX_GROUP_BUCKETS + 1,
    };
    await expect(
      compile.groupedCountResource(context.user, "patients", "department_id"),
    ).rejects.toMatchObject({
      reason: "invalid_aggregate",
      details: { max_groups: compile.MAX_GROUP_BUCKETS },
    });
  });

  it("denies grouping before any lookup when the resource feature is absent", async () => {
    const { compile, mocks, context } = await load("admin", { readFeature: false });
    await expect(
      compile.groupedCountResource(context.user, "patients", "blood_type"),
    ).rejects.toMatchObject({ reason: "feature_not_entitled" });
    expect(mocks.state.queryLog).toHaveLength(0);
  });

  it.each(["admin", "manager", "receptionist", "doctor", "assistant"] as const)(
    "keeps grouping available to %s exactly where the patients resource is",
    async (role) => {
      const { compile, mocks, context } = await load(role);
      mocks.state.tableResults.patients = bucketCounts([
        1, 0, 0, 0, 0, 0, 0, 0, 0, 1,
      ]);
      const result = await compile.groupedCountResource(
        context.user,
        "patients",
        "blood_type",
      );
      // RLS narrows a doctor's and an assistant's rows at the database; the
      // registry adds no extra AI-local role restriction on top of it.
      expect(result.suppressed).toBe(false);
      expect(result.resource).toBe("patients");
    },
  );
});

describe("aggregate_resource group_by wiring", () => {
  it("routes a registered group key to the grouped path", async () => {
    const { tools, mocks } = await load("admin");
    mocks.state.tableResults.patients = bucketCounts([
      3, 0, 0, 0, 0, 0, 0, 0, 0, 3,
    ]);
    const output = await tools.aggregate_resource!.execute!(
      { resource: "patients", metric: "count", group_by: "blood_type", filters: {} },
      opts,
    );
    expect(output).toMatchObject({
      group_by: "blood_type",
      suppressed: false,
      groups: [{ key: "A+", count: 3 }],
    });
  });

  it("returns a structured invalid_aggregate the model can self-correct from", async () => {
    const { tools } = await load("admin");
    const output = await tools.aggregate_resource!.execute!(
      { resource: "patients", metric: "count", group_by: "phone", filters: {} },
      opts,
    );
    expect(output).toMatchObject({
      invalid_request: true,
      reason: "invalid_aggregate",
      valid_group_by: ["blood_type", "department_id", "assigned_doctor_id"],
    });
  });

  it("still answers an ungrouped single-cell count exactly", async () => {
    const { tools, mocks } = await load("admin");
    mocks.state.tableResults.patients = { data: [], error: null, count: 2 };
    const output = await tools.aggregate_resource!.execute!(
      {
        resource: "patients",
        metric: "count",
        filters: { blood_type: "O+" },
      },
      opts,
    );
    expect(output).toMatchObject({ metric: "count", value: 2, group_by: null });
  });
});

describe("the statistical path points at the authorized path instead of refusing", () => {
  it("attaches a re-route pointer naming a group key aggregate_resource accepts", async () => {
    const { tools, mocks } = await load("admin");
    mocks.state.rpcResults.ai_get_patient_stats = {
      data: { distribution_withheld: true, buckets_all_time: [] },
      error: null,
    };
    const output = (await tools.get_patient_stats!.execute!(
      { group_by: "blood_type", preset: "last_30_days" },
      opts,
    )) as { authorized_alternative: Record<string, unknown> };

    expect(output.authorized_alternative).toMatchObject({
      resource: "patients",
      group_by: "blood_type",
      aggregate_tool: "aggregate_resource",
      list_tool: "query_resource",
    });
    expect(String(output.authorized_alternative.guidance)).toContain(
      "instead of reporting that the information cannot be shown",
    );
  });

  it("maps every statistical group_by onto a registered patients group key", async () => {
    const { compile, mocks, context } = await load("admin");
    const { RESOURCE_REGISTRY_BY_ID } = await import("@/lib/ai/resources/registry");
    const registered = RESOURCE_REGISTRY_BY_ID.get("patients")!.aggregates!.groupBy;

    for (const groupBy of ["department", "blood_type", "assigned_doctor"] as const) {
      mocks.state.rpcResults.ai_get_patient_stats = { data: {}, error: null };
      const { tools } = await load("admin");
      const output = (await tools.get_patient_stats!.execute!(
        { group_by: groupBy, preset: "last_30_days" },
        opts,
      )) as { authorized_alternative: { group_by: string } };
      expect(registered).toContain(output.authorized_alternative.group_by);
    }
    // The mapping is only useful if the compiler really accepts those keys.
    expect(() =>
      compile.compileResourceQueryPlan(context.user, "patients", {}),
    ).not.toThrow();
  });

  it("keeps the k-anonymous suppression on the statistical tool itself", async () => {
    const { tools, mocks } = await load("admin");
    mocks.state.rpcResults.ai_get_patient_stats = {
      data: {
        patients_total: 41,
        buckets_all_time: [
          { label: "Other", count: 6, suppression_reason: "aggregated", grouped_bucket_count: 3 },
        ],
      },
      error: null,
    };
    const output = (await tools.get_patient_stats!.execute!(
      { group_by: "blood_type", preset: "last_30_days" },
      opts,
    )) as { stats: { buckets_all_time: { suppression_reason: string }[] } };
    // Unchanged: this tool is still a suppressed statistical release. Only the
    // *scope* of that suppression was corrected, never the suppression itself.
    expect(output.stats.buckets_all_time[0]!.suppression_reason).toBe("aggregated");
  });
});

describe("prompt guidance bounds suppression to the statistical tool", () => {
  it("tells both personas to answer from the authorized path, in both locales", async () => {
    const { buildStaffSystemPrompt } = await import("@/lib/ai/prompts/staff");
    for (const role of ["admin", "doctor"] as const) {
      const en = buildStaffSystemPrompt({
        role,
        locale: "en",
        clinicName: "Clinic",
        doctorName: "User",
      });
      expect(en).toContain("Statistical suppression applies to the get_patient_stats tool only");
      expect(en).toContain("do not tell the user the information cannot be shown");
      expect(en).toContain("which patients have O+ blood");
      // The false generalization the pass removed must not come back.
      expect(en).not.toContain(
        "tell the user this grouping cannot be reported for their clinic without identifying individuals",
      );

      const ar = buildStaffSystemPrompt({
        role,
        locale: "ar",
        clinicName: "عيادة",
        doctorName: "مستخدم",
      });
      expect(ar).toContain("get_patient_stats");
      expect(ar).toContain("aggregate_resource");
      expect(ar).toContain("query_resource");
    }
  });

  it("keeps the information boundary the plan preserved", async () => {
    const { buildStaffSystemPrompt } = await import("@/lib/ai/prompts/staff");
    const prompt = buildStaffSystemPrompt({
      role: "admin",
      locale: "en",
      clinicName: "Clinic",
      doctorName: "User",
    });
    // Widening what may be *reported* must not widen what may be *advised*.
    expect(prompt).toContain(
      "never provide a diagnosis, treatment recommendation, or drug/dose suggestion",
    );
    expect(prompt).toContain("never derive one by subtracting from any total");
  });
});

describe("registry invariants for grouped aggregates", () => {
  it("declares one spec per group key, on a registered filter, with a parseable enum domain", async () => {
    const { RESOURCE_REGISTRY } = await import("@/lib/ai/resources/registry");
    for (const definition of RESOURCE_REGISTRY) {
      const aggregates = definition.aggregates;
      if (!aggregates) continue;
      for (const key of aggregates.groupBy) {
        const spec = aggregates.groups?.[key];
        expect(spec, `${definition.id}.${key} has no group spec`).toBeDefined();
        const filter = definition.filters[spec!.filter];
        expect(filter, `${definition.id}.${key} names an unregistered filter`).toBeDefined();
        expect(filter!.operators).toContain("eq");
        // A null bucket is compiled as `is null`, so the filter must allow it.
        if (spec!.includeNull) expect(filter!.operators).toContain("is");
        if (spec!.domain.kind === "enum") {
          for (const value of spec!.domain.values) {
            expect(
              filter!.schema.safeParse(value).success,
              `${definition.id}.${key} enum value ${value} fails its own filter schema`,
            ).toBe(true);
          }
        }
      }
      // No orphan spec: a key with a spec but absent from groupBy is unreachable.
      for (const key of Object.keys(aggregates.groups ?? {})) {
        expect(aggregates.groupBy).toContain(key);
      }
    }
  });

  it("never exposes a server-owned column or filter name through describe_capabilities", async () => {
    const { tools } = await load("admin");
    const described = (await tools.describe_capabilities!.execute!(
      { resource: "patients" },
      opts,
    )) as { resources: { aggregates: { groups: { key: string }[] } }[] };
    const aggregates = described.resources[0]!.aggregates;
    expect(Object.keys(aggregates.groups[0]!)).toEqual([
      "key",
      "description",
      "includes_unset_bucket",
    ]);
    expect(JSON.stringify(aggregates)).not.toContain("filter");
    expect(JSON.stringify(aggregates)).not.toContain("domain");
  });
});
