import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { isKnownAiFeature } from "@/lib/ai/commercial-policy";
import {
  AiResourceInputError,
  MAX_PAGE,
  compileResourceQueryPlan,
  executeCompiledResourceQuery,
} from "@/lib/ai/resources/compile";
import { RESOURCE_REGISTRY } from "@/lib/ai/resources/registry";
import { RESOURCE_IDS } from "@/lib/ai/resources/types";
import { PERMISSION_USER_ROLES } from "@/lib/page-permissions";
import type { AuthedUser, UserRole } from "@/lib/rbac";

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "11111111-1111-4111-8111-111111111111";

function user(role: UserRole = "admin"): AuthedUser {
  return {
    id: USER,
    email: "user@example.test",
    role,
    fullName: "Resource User",
    avatarUrl: null,
    clinicId: CLINIC,
    departmentId: null,
    mustChangePassword: false,
  };
}

type Result = {
  data: unknown[] | null;
  error: { message: string } | null;
  count: number | null;
};

class FakeQuery {
  readonly calls: { method: string; args: unknown[] }[] = [];

  constructor(private readonly result: Result) {}

  private call(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
    return this;
  }

  select(...args: unknown[]) { return this.call("select", ...args); }
  eq(...args: unknown[]) { return this.call("eq", ...args); }
  neq(...args: unknown[]) { return this.call("neq", ...args); }
  in(...args: unknown[]) { return this.call("in", ...args); }
  gt(...args: unknown[]) { return this.call("gt", ...args); }
  gte(...args: unknown[]) { return this.call("gte", ...args); }
  lt(...args: unknown[]) { return this.call("lt", ...args); }
  lte(...args: unknown[]) { return this.call("lte", ...args); }
  ilike(...args: unknown[]) { return this.call("ilike", ...args); }
  is(...args: unknown[]) { return this.call("is", ...args); }
  order(...args: unknown[]) { return this.call("order", ...args); }
  range(...args: unknown[]) { return this.call("range", ...args); }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function fakeClient(results: Result[]) {
  const queries: FakeQuery[] = [];
  return {
    queries,
    client: {
      from: vi.fn(() => {
        const next = results.shift();
        if (!next) throw new Error("No fake query result remains.");
        const query = new FakeQuery(next);
        queries.push(query);
        return query;
      }),
    },
  };
}

function expectInputError(
  run: () => unknown,
  reason: AiResourceInputError["reason"],
) {
  try {
    run();
    throw new Error("Expected compiler to reject input.");
  } catch (error) {
    expect(error).toBeInstanceOf(AiResourceInputError);
    expect((error as AiResourceInputError).reason).toBe(reason);
  }
}

describe("Phase 1 resource registry invariants", () => {
  it("declares exactly the registered resources with non-empty known feature gates", () => {
    expect(RESOURCE_REGISTRY.map((definition) => definition.id)).toEqual(RESOURCE_IDS);
    for (const definition of RESOURCE_REGISTRY) {
      expect(definition.requiredFeatures.length).toBeGreaterThan(0);
      expect(definition.requiredFeatures.every(isKnownAiFeature)).toBe(true);
      expect(definition.rowCap).toBeGreaterThan(0);
      expect(definition.rowCap).toBeLessThanOrEqual(500);
    }
  });

  it("keeps every resource role within the app role source of truth", () => {
    const appRoles = new Set(PERMISSION_USER_ROLES);
    for (const definition of RESOURCE_REGISTRY) {
      expect(definition.roles.length).toBeGreaterThan(0);
      expect(definition.roles.every((role) => appRoles.has(role))).toBe(true);
      for (const role of definition.roles) {
        expect(definition.fieldPolicy(user(role))).toEqual(
          expect.arrayContaining(definition.defaultFields as string[]),
        );
      }
    }
  });
});

describe("Phase 1 query compiler", () => {
  it("rejects unknown resources, filters, operators, values, fields, relations, and sorts", () => {
    expectInputError(
      () => compileResourceQueryPlan(user(), "not_a_table", {}),
      "invalid_resource",
    );
    expectInputError(
      () => compileResourceQueryPlan(user(), "patients", { filters: { unknown: "x" } }),
      "invalid_filter",
    );
    expectInputError(
      () =>
        compileResourceQueryPlan(user(), "patients", {
          filters: {
            department: { operator: "gt", value: "Dermatology" },
          },
        }),
      "invalid_operator",
    );
    expectInputError(
      () => compileResourceQueryPlan(user(), "patients", { filters: { id: "not-uuid" } }),
      "invalid_filter_value",
    );
    expectInputError(
      () => compileResourceQueryPlan(user(), "patients", { fields: ["password"] }),
      "invalid_field",
    );
    expectInputError(
      () => compileResourceQueryPlan(user(), "patients", { relations: { invoices: [] } }),
      "invalid_relation",
    );
    expectInputError(
      () => compileResourceQueryPlan(user(), "patients", { sort: "clinic_id" }),
      "invalid_sort",
    );
  });

  it("applies the field policy and keeps national_id explicit-only", () => {
    const defaults = compileResourceQueryPlan(user("receptionist"), "patients", {});
    expect(defaults.fields).toEqual([
      "id",
      "full_name",
      "file_number",
      "department_id",
      "assigned_doctor_id",
    ]);
    expect(defaults.select).not.toContain("national_id");
    expect(defaults.resource.fieldPolicy(user("receptionist"))).toContain("blood_type");

    const explicit = compileResourceQueryPlan(user("receptionist"), "patients", {
      fields: ["id", "full_name", "national_id"],
      page_size: 25,
    });
    expect(explicit.select).toBe("id,full_name,national_id");
    expect(explicit.sensitiveListLimit).toBe(25);
  });

  it("always injects the caller-owned tenant predicate and caps pagination", () => {
    for (const id of RESOURCE_IDS) {
      const compiled = compileResourceQueryPlan(user("doctor"), id, {
        page: 2,
        page_size: 200,
      });
      expect(compiled.tenantPredicate).toEqual({
        column:
          id === "medical_notes" ? "__tenant_patient.clinic_id" : "clinic_id",
        value: CLINIC,
      });
      expect(compiled.pageSize).toBeLessThanOrEqual(compiled.resource.rowCap);
      expect(compiled.range).toEqual({ from: 200, toWithSentinel: 400 });
    }
    expectInputError(
      () => compileResourceQueryPlan(user(), "patients", { page_size: 201 }),
      "invalid_pagination",
    );
    try {
      compileResourceQueryPlan(user(), "patients", { page: MAX_PAGE + 1 });
      throw new Error("Expected compiler to reject a deep page.");
    } catch (error) {
      expect(error).toBeInstanceOf(AiResourceInputError);
      expect(error).toMatchObject({
        reason: "invalid_pagination",
        details: { max_page: MAX_PAGE, max_page_size: 200 },
      });
    }
  });

  it("adds an ascending id tiebreaker for every declared sort and direction", () => {
    for (const definition of RESOURCE_REGISTRY) {
      for (const sort of definition.sorts) {
        for (const direction of ["asc", "desc"] as const) {
          const compiled = compileResourceQueryPlan(user(), definition.id, {
            sort,
            direction,
          });
          expect(compiled.sort).toEqual({
            key: sort,
            column: definition.fields[sort]!.column,
            direction,
          });
          expect(compiled.tiebreak).toEqual({ column: "id", direction: "asc" });
        }
      }
    }
  });

  it("rejects sorting by a field withheld by field policy", () => {
    const definition = RESOURCE_REGISTRY.find((entry) => entry.id === "patients")!;
    const dateOfBirth = definition.fields.date_of_birth!;
    const originalRoles = dateOfBirth.roles;
    dateOfBirth.roles = ["admin"];
    try {
      compileResourceQueryPlan(user("receptionist"), "patients", {
        sort: "date_of_birth",
      });
      throw new Error("Expected compiler to reject a withheld sort.");
    } catch (error) {
      expect(error).toBeInstanceOf(AiResourceInputError);
      expect(error).toMatchObject({ reason: "invalid_sort" });
      expect((error as AiResourceInputError).details.valid_sorts).not.toContain(
        "date_of_birth",
      );
    } finally {
      dateOfBirth.roles = originalRoles;
    }
  });

  it("fetches cap+1, reports an exact total, and marks truncation honestly", async () => {
    const compiled = compileResourceQueryPlan(user(), "patients", {
      fields: ["id", "full_name"],
      page_size: 2,
    });
    const fake = fakeClient([
      {
        data: [
          { id: "1", full_name: "One" },
          { id: "2", full_name: "Two" },
          { id: "3", full_name: "Three" },
        ],
        error: null,
        count: 7,
      },
    ]);
    const result = await executeCompiledResourceQuery(
      user(),
      compiled,
      fake.client as never,
    );
    expect("rows" in result && result.rows).toHaveLength(2);
    expect(result).toMatchObject({
      total: 7,
      page: 1,
      page_size: 2,
      truncated: true,
      notice: "Showing rows 1–2 of 7.",
    });
    expect(fake.queries[0]?.calls).toContainEqual({
      method: "eq",
      args: ["clinic_id", CLINIC],
    });
    expect(fake.queries[0]?.calls).toContainEqual({
      method: "range",
      args: [0, 2],
    });
    expect(fake.queries[0]?.calls.filter((call) => call.method === "order")).toEqual([
      { method: "order", args: ["full_name", { ascending: true }] },
      { method: "order", args: ["id", { ascending: true }] },
    ]);
  });

  it("reports the current row window on later pages and omits notices for complete first pages", async () => {
    const secondPage = compileResourceQueryPlan(user(), "patients", {
      fields: ["id", "full_name"],
      page: 2,
      page_size: 2,
    });
    const paged = fakeClient([{
      data: [{ id: "3" }, { id: "4" }, { id: "5" }],
      error: null,
      count: 7,
    }]);
    await expect(
      executeCompiledResourceQuery(user(), secondPage, paged.client as never),
    ).resolves.toMatchObject({
      page: 2,
      truncated: true,
      notice: "Showing rows 3–4 of 7.",
    });

    const firstPage = compileResourceQueryPlan(user(), "patients", {
      fields: ["id"],
      page_size: 2,
    });
    const complete = fakeClient([{
      data: [{ id: "1" }, { id: "2" }],
      error: null,
      count: 2,
    }]);
    await expect(
      executeCompiledResourceQuery(user(), firstPage, complete.client as never),
    ).resolves.toMatchObject({ truncated: false, notice: null });
  });

  it("refuses national_id when the authorized result exceeds 25 rows", async () => {
    const compiled = compileResourceQueryPlan(user(), "patients", {
      fields: ["id", "national_id"],
      page_size: 25,
    });
    const fake = fakeClient([{ data: null, error: null, count: 26 }]);
    await expect(
      executeCompiledResourceQuery(user(), compiled, fake.client as never),
    ).rejects.toMatchObject({ reason: "sensitive_field_bulk_refused" });
  });

  it("keeps ilike wildcard shape server-owned and validates null checks", async () => {
    const compiled = compileResourceQueryPlan(user(), "patients", {
      fields: ["id", "full_name"],
      filters: { full_name: { operator: "ilike", value: "%_Derm\\" } },
    });
    const fake = fakeClient([{ data: [], error: null, count: 0 }]);
    await executeCompiledResourceQuery(user(), compiled, fake.client as never);
    expect(fake.queries[0]?.calls).toContainEqual({
      method: "ilike",
      args: ["full_name", "%\\%\\_Derm\\\\%"],
    });
    expectInputError(
      () =>
        compileResourceQueryPlan(user(), "patients", {
          filters: { blood_type: { operator: "is", value: "A+" } },
        }),
      "invalid_filter_value",
    );
  });

  it("rejects PostgREST's star wildcard before a query can be built", () => {
    try {
      compileResourceQueryPlan(user(), "patients", {
        fields: ["id"],
        filters: { full_name: { operator: "ilike", value: "Derm*Clinic" } },
      });
      throw new Error("Expected compiler to reject a PostgREST star wildcard.");
    } catch (error) {
      expect(error).toBeInstanceOf(AiResourceInputError);
      expect(error).toMatchObject({
        reason: "invalid_filter_value",
        details: { field: "full_name", forbidden_character: "*" },
      });
    }
  });

  it("uses the same unauthorized_scope denial for missing and inaccessible ids", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const compiled = compileResourceQueryPlan(user(), "patients", {
      fields: ["id", "full_name"],
      filters: { id },
      page_size: 1,
    });
    for (const result of [
      { data: [], error: null, count: 0 },
      { data: [], error: null, count: 0 },
    ]) {
      const fake = fakeClient([result]);
      await expect(
        executeCompiledResourceQuery(user(), compiled, fake.client as never),
      ).rejects.toMatchObject({ reason: "unauthorized_scope" });
    }
  });

  it("compiles relation fields from registered allow-lists only", () => {
    const compiled = compileResourceQueryPlan(user(), "patients", {
      relations: { department: ["id", "name"] },
    });
    expect(compiled.select).toContain(
      "department:departments!patients_department_id_fkey(id,name)",
    );
    expectInputError(
      () =>
        compileResourceQueryPlan(user(), "patients", {
          relations: { department: ["clinic_id"] },
        }),
      "invalid_field",
    );
  });
});
