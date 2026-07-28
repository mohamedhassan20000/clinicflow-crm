import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  createServerClient: vi.fn(),
}));
vi.mock("@/lib/rbac", () => ({ requirePlatformAdmin: mocks.requirePlatformAdmin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createServerClient }));

import {
  loadOperatorReportFilterOptions,
  operatorReportRegistry,
} from "@/lib/operator-reports/registry";
import { parseReportParams } from "@/lib/operator-reports/types";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secret = process.env.LOCAL_SUPABASE_SECRET_KEY;
if (!secret) throw new Error("LOCAL_SUPABASE_SECRET_KEY is required");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secret;
const service = createClient<Database>(url, secret, { auth: { persistSession: false } });
const suffix = crypto.randomUUID();
const invitationFixtureDay = new Date().toISOString().slice(0, 10);
const clinicIds: string[] = [];
const authIds: string[] = [];
let basicPlanId: string;

function report(id: string) {
  return operatorReportRegistry.get(id)!;
}

beforeAll(async () => {
  mocks.createServerClient.mockImplementation(async () => service);
  const clinics = await service.from("clinics").insert(
    Array.from({ length: 27 }, (_, index) => ({
      name: `WS7 ${suffix} Clinic ${String(index + 1).padStart(2, "0")}`,
      country: "ZZ",
      onboarding_completed_at: index % 2 === 0 ? "2026-07-01T00:00:00.000Z" : null,
      created_at: `2026-07-${String((index % 27) + 1).padStart(2, "0")}T12:00:00.000Z`,
    })),
  ).select("id");
  if (clinics.error) throw clinics.error;
  clinicIds.push(...clinics.data.map((clinic) => clinic.id));

  const plan = await service.from("plans").select("id").eq("slug", "basic").single();
  if (plan.error) throw plan.error;
  basicPlanId = plan.data.id;

  for (let index = 0; index < 3; index += 1) {
    const auth = await service.auth.admin.createUser({
      email: `ws7-${suffix}-${index}@example.com`,
      password: "WS7Testing123!",
      email_confirm: true,
    });
    if (auth.error || !auth.data.user) throw auth.error;
    authIds.push(auth.data.user.id);
  }
  const profiles = await service.from("profiles").insert([
    { id: authIds[0]!, clinic_id: clinicIds[0]!, full_name: "WS7 Aggregate A", role: "admin", created_at: "2026-05-01T00:00:00.000Z" },
    { id: authIds[1]!, clinic_id: clinicIds[0]!, full_name: "WS7 Aggregate B", role: "doctor", created_at: "2026-06-01T00:00:00.000Z" },
    { id: authIds[2]!, clinic_id: clinicIds[1]!, full_name: "WS7 Aggregate C", role: "admin", created_at: "2026-04-01T00:00:00.000Z" },
  ]);
  if (profiles.error) throw profiles.error;

  const subscriptions = await service.from("subscriptions").insert([
    { clinic_id: clinicIds[0]!, plan_id: basicPlanId, status: "active", provider: "manual", current_period_end: "2026-09-01T00:00:00.000Z" },
    { clinic_id: clinicIds[1]!, plan_id: basicPlanId, status: "trialing", provider: "manual", trial_ends_at: "2026-08-01T00:00:00.000Z" },
  ]);
  if (subscriptions.error) throw subscriptions.error;

  const acceptedInvitations = Array.from({ length: 27 }, (_, index) => ({
    clinic_name: `WS7 ${suffix} Accepted ${String(index + 1).padStart(2, "0")}`,
    owner_name: "WS7 Owner",
    phone: `+1202555${String(1000 + index)}`,
    email: `ws7-${suffix}-accepted-${index}@example.com`,
    status: "accepted" as const,
    accepted_clinic_id: clinicIds[0]!,
    accepted_at: `${invitationFixtureDay}T13:${String(index).padStart(2, "0")}:00.000Z`,
    email_sent_at: index % 2 === 0
      ? `${invitationFixtureDay}T11:${String(index).padStart(2, "0")}:00.000Z`
      : null,
    created_at: `${invitationFixtureDay}T12:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  const invitations = await service.from("clinic_invitations").insert([
    ...acceptedInvitations,
    { clinic_name: `WS7 ${suffix} Pending`, owner_name: "WS7 Owner", phone: "+12025550100", email: `ws7-${suffix}-pending@example.com`, status: "pending", email_sent_at: `${invitationFixtureDay}T10:00:00.000Z`, created_at: `${invitationFixtureDay}T12:40:00.000Z` },
    { clinic_name: `WS7 ${suffix} Unsent`, owner_name: "WS7 Owner", phone: "+12025550101", email: `ws7-${suffix}-unsent@example.com`, status: "pending", created_at: `${invitationFixtureDay}T12:41:00.000Z` },
    { clinic_name: `WS7 ${suffix} Revoked`, owner_name: "WS7 Owner", phone: "+12025550102", email: `ws7-${suffix}-revoked@example.com`, status: "revoked", revoked_at: `${invitationFixtureDay}T13:00:00.000Z`, created_at: `${invitationFixtureDay}T12:42:00.000Z` },
    { clinic_name: `WS7 ${suffix} Expired`, owner_name: "WS7 Owner", phone: "+12025550103", email: `ws7-${suffix}-expired@example.com`, status: "expired", created_at: `${invitationFixtureDay}T12:43:00.000Z` },
  ]);
  if (invitations.error) throw invitations.error;

  const audit = await service.from("platform_audit_logs").insert({
    action: `ws7_filter_${suffix}`,
    target_type: "clinic",
    target_id: clinicIds[0],
    clinic_id: clinicIds[0],
    created_at: "2026-07-12T00:00:00.000Z",
  });
  if (audit.error) throw audit.error;
});

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset();
  mocks.requirePlatformAdmin.mockResolvedValue({ id: "operator" });
  mocks.createServerClient.mockClear();
});

afterAll(async () => {
  await service.from("platform_audit_logs").delete().eq("action", `ws7_filter_${suffix}`);
  await service.from("clinic_invitations").delete().like("email", `ws7-${suffix}-%`);
  await service.from("subscriptions").delete().in("clinic_id", clinicIds);
  await service.from("profiles").delete().in("id", authIds);
  await service.from("clinics").delete().in("id", clinicIds);
  for (const id of authIds) await service.auth.admin.deleteUser(id);
});

describe("Pre-P2 WS7 operator report queries", () => {
  it("applies filters before global sorting and server pagination, then exports every filtered page", async () => {
    const definition = report("clinics");
    const params = parseReportParams(definition, {
      country: "ZZ",
      onboarding: "all",
      createdFrom: "",
      createdTo: "",
      sort: "created_at",
      dir: "desc",
      page: "2",
      pageSize: "25",
    });
    const page = await definition.query(params);
    expect(page.total).toBe(27);
    expect(page.page).toBe(2);
    expect(page.rows).toHaveLength(2);
    expect(page.rows.every((row) => row.country === "ZZ")).toBe(true);
    expect(String(page.rows[0]?.created_at) >= String(page.rows[1]?.created_at)).toBe(true);

    const exported = await definition.query(params, "export");
    expect(exported.rows).toHaveLength(27);
    expect(exported.rows.every((row) => row.country === "ZZ")).toBe(true);
    expect(definition.export(exported.rows).split("\n")).toHaveLength(28);
  });

  it("keeps Users aggregate-only, correctly sorted, and free of profile PII", async () => {
    const definition = report("users");
    const params = parseReportParams(definition, {
      clinic: clinicIds[0],
      signupFrom: "",
      signupTo: "",
      sort: "user_count",
      dir: "desc",
    });
    const result = await definition.query(params);
    expect(result.rows).toEqual([{
      clinic_id: clinicIds[0],
      clinic_name: `WS7 ${suffix} Clinic 01`,
      user_count: 2,
      latest_signup: "2026-06-01T00:00:00+00:00",
    }]);
    const serialized = JSON.stringify(result.rows);
    expect(serialized).not.toContain("Aggregate A");
    expect(serialized).not.toContain("@example.com");
    expect(serialized).not.toContain("phone");

    const exported = await definition.query(params, "export");
    expect(exported.rows).toEqual(result.rows);
  });

  it("covers every invitation filter, both sort directions, page 2, and export", async () => {
    const definition = report("invitations");
    for (const status of ["all", "pending", "accepted", "revoked", "expired"]) {
      const result = await definition.query(parseReportParams(definition, {
        status,
        clinic: "all",
        createdFrom: invitationFixtureDay,
        createdTo: invitationFixtureDay,
        emailSent: "all",
      }));
      expect(
        result.rows.some((row) => String(row.clinic_name).includes(suffix)),
        `status=${status}`,
      ).toBe(true);
      if (status !== "all") {
        expect(result.rows.every((row) => row.status === status)).toBe(true);
      }
    }

    for (const emailSent of ["yes", "no"]) {
      const result = await definition.query(parseReportParams(definition, {
        status: "accepted",
        clinic: clinicIds[0],
        createdFrom: invitationFixtureDay,
        createdTo: invitationFixtureDay,
        emailSent,
      }));
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows.every((row) => emailSent === "yes"
        ? row.email_sent_at !== null
        : row.email_sent_at === null)).toBe(true);
    }

    const base = {
      status: "accepted",
      clinic: clinicIds[0]!,
      createdFrom: invitationFixtureDay,
      createdTo: invitationFixtureDay,
      emailSent: "all",
      sort: "created_at",
      pageSize: "25",
    };
    const [ascending, descending, secondPage, exported] = await Promise.all([
      definition.query(parseReportParams(definition, { ...base, dir: "asc" })),
      definition.query(parseReportParams(definition, { ...base, dir: "desc" })),
      definition.query(parseReportParams(definition, { ...base, dir: "desc", page: "2" })),
      definition.query(parseReportParams(definition, { ...base, dir: "desc" }), "export"),
    ]);

    expect(ascending.total).toBe(27);
    expect(String(ascending.rows[0]?.created_at) < String(ascending.rows.at(-1)?.created_at)).toBe(true);
    expect(String(descending.rows[0]?.created_at) > String(descending.rows.at(-1)?.created_at)).toBe(true);
    expect(secondPage).toEqual(expect.objectContaining({ total: 27, page: 2, totalPages: 2 }));
    expect(secondPage.rows).toHaveLength(2);
    expect(exported.rows).toHaveLength(27);
    expect(definition.export(exported.rows).split("\n")).toHaveLength(28);
  });

  it("keeps Revenue page/export filters aligned on canonical USD subscription values", async () => {
    const definition = report("revenue");
    const params = parseReportParams(definition, {
      plan: "basic",
      status: "active",
      renewalFrom: "2026-09-01",
      renewalTo: "2026-09-01",
      sort: "current_period_end",
      dir: "asc",
    });
    const [page, exported] = await Promise.all([
      definition.query(params),
      definition.query(params, "export"),
    ]);
    const expected = page.rows.filter((row) => row.clinic_id === clinicIds[0]);
    expect(expected).toEqual([expect.objectContaining({
      clinic_id: clinicIds[0],
      plan: "Basic",
      status: "active",
      current_period_end: "2026-09-01T00:00:00+00:00",
    })]);
    expect(exported.rows.filter((row) => row.clinic_id === clinicIds[0])).toEqual(expected);
    expect(Number(expected[0]?.monthly_price_usd)).toBeGreaterThanOrEqual(0);
  });

  it("forces trial windows to trialing and applies provider/plan filters to page and export", async () => {
    const definition = report("subscriptions");
    const params = parseReportParams(definition, {
      status: "active",
      provider: "manual",
      plan: "basic",
      trialFrom: "2026-08-01",
      trialTo: "2026-08-01",
      sort: "trial_ends_at",
      dir: "asc",
    });
    expect(params.filters.status).toBe("trialing");
    const [page, exported] = await Promise.all([
      definition.query(params),
      definition.query(params, "export"),
    ]);
    const expected = page.rows.filter((row) => row.clinic_id === clinicIds[1]);
    expect(expected).toEqual([expect.objectContaining({
      clinic_id: clinicIds[1],
      plan: "Basic",
      status: "trialing",
      provider: "manual",
      trial_ends_at: "2026-08-01T00:00:00+00:00",
    })]);
    expect(exported.rows.filter((row) => row.clinic_id === clinicIds[1])).toEqual(expected);
  });

  it("uses identical Activity filters for the page and export without exposing audit details", async () => {
    const definition = report("activity");
    const params = parseReportParams(definition, {
      action: `ws7_filter_${suffix}`,
      targetType: "clinic",
      createdFrom: "2026-07-12",
      createdTo: "2026-07-12",
      sort: "created_at",
      dir: "desc",
    });
    const [page, exported] = await Promise.all([
      definition.query(params),
      definition.query(params, "export"),
    ]);
    expect(page.rows).toEqual([expect.objectContaining({
      action: `ws7_filter_${suffix}`,
      target_type: "clinic",
    })]);
    expect(exported.rows).toEqual(page.rows);
    expect(JSON.stringify(page.rows)).not.toContain("details");
  });

  it("builds month-granularity Growth rows and keeps page/export totals consistent", async () => {
    const definition = report("growth");
    const params = parseReportParams(definition, {
      monthFrom: "2026-07",
      monthTo: "2026-07",
      sort: "month",
      dir: "asc",
    });
    const [page, exported] = await Promise.all([
      definition.query(params),
      definition.query(params, "export"),
    ]);
    expect(page.rows).toEqual([{ month: "2026-07", new_clinics: expect.any(Number) }]);
    expect(Number(page.rows[0]?.new_clinics)).toBeGreaterThanOrEqual(27);
    expect(exported.rows).toEqual(page.rows);
  });

  it("re-guards every report query and dynamic filter option path", async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Error("PLATFORM_ADMIN_REQUIRED"));
    const rawByReport: Record<string, Record<string, string>> = {
      clinics: { country: "all", onboarding: "all", createdFrom: "", createdTo: "" },
      users: { clinic: "all", signupFrom: "", signupTo: "" },
      invitations: { status: "all", clinic: "all", createdFrom: "", createdTo: "", emailSent: "all" },
      revenue: { plan: "all", status: "all", renewalFrom: "", renewalTo: "" },
      subscriptions: { status: "all", provider: "all", plan: "all", trialFrom: "", trialTo: "" },
      activity: {
        action: "",
        targetType: "",
        createdFrom: "",
        createdTo: "",
      },
      growth: { monthFrom: "", monthTo: "" },
      "ai-usage": { clinic: "all", monthFrom: "", monthTo: "" },
      "ai-provider-health": { clinic: "all", mode: "all", health: "all" },
      "messaging-cost": { clinic: "all", monthFrom: "", monthTo: "" },
      "whatsapp-health": { clinic: "all", provider: "all", health: "all" },
    };
    for (const definition of operatorReportRegistry.values()) {
      const params = parseReportParams(definition, rawByReport[definition.id]!);
      await expect(definition.query(params)).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    }
    await expect(loadOperatorReportFilterOptions(report("clinics"))).rejects.toThrow(
      "PLATFORM_ADMIN_REQUIRED",
    );
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });
});
