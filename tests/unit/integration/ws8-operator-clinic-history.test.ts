import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/types/database";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ requirePlatformAdmin: vi.fn() }));
vi.mock("@/lib/rbac", () => ({ requirePlatformAdmin: mocks.requirePlatformAdmin }));

import {
  getOperatorClinicHistory,
  parseOperatorClinicUsageParams,
} from "@/lib/supabase/admin";

const url = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54321";
const secret = process.env.LOCAL_SUPABASE_SECRET_KEY;
if (!secret) throw new Error("LOCAL_SUPABASE_SECRET_KEY is required");
process.env.NEXT_PUBLIC_SUPABASE_URL = url;
process.env.SUPABASE_SERVICE_ROLE_KEY = secret;
const service = createClient<Database>(url, secret, { auth: { persistSession: false } });
const suffix = crypto.randomUUID();
let clinicId: string;
let subscriptionId: string;
let invitationId: string;
let couponId: string;

function allKeys(value: unknown, keys = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      allKeys(item, keys);
    }
  }
  return keys;
}

beforeAll(async () => {
  const plan = await service.from("plans").select("id").eq("slug", "basic").single();
  if (plan.error) throw plan.error;
  const clinic = await service
    .from("clinics")
    .insert({
      name: `WS8 Clinic ${suffix}`,
      country: "KW",
      timezone: "Asia/Kuwait",
      locale: "en",
      currency: "KWD",
      onboarding_completed_at: "2026-07-02T09:00:00.000Z",
      created_at: "2026-07-01T09:00:00.000Z",
    })
    .select("id")
    .single();
  if (clinic.error) throw clinic.error;
  clinicId = clinic.data.id;

  const subscription = await service
    .from("subscriptions")
    .insert({
      clinic_id: clinicId,
      plan_id: plan.data.id,
      provider: "manual",
      status: "active",
      current_period_start: "2026-07-01T09:00:00.000Z",
      current_period_end: "2026-10-01T09:00:00.000Z",
      created_at: "2026-07-01T09:00:00.000Z",
    })
    .select("id")
    .single();
  if (subscription.error) throw subscription.error;
  subscriptionId = subscription.data.id;

  const invitation = await service
    .from("clinic_invitations")
    .insert({
      clinic_name: `WS8 Clinic ${suffix}`,
      owner_name: "WS8 Private Owner",
      phone: "+96555555555",
      email: `ws8-private-${suffix}@example.com`,
      status: "accepted",
      accepted_clinic_id: clinicId,
      accepted_at: "2026-07-01T08:55:00.000Z",
      email_sent_at: "2026-06-30T12:00:00.000Z",
      created_at: "2026-06-30T10:00:00.000Z",
    })
    .select("id")
    .single();
  if (invitation.error) throw invitation.error;
  invitationId = invitation.data.id;

  const coupon = await service
    .from("coupons")
    .insert({
      code: `WS8${suffix.replaceAll("-", "").toUpperCase()}FREE`,
      kind: "months_free",
      months: 3,
      clinic_id: clinicId,
    })
    .select("id")
    .single();
  if (coupon.error) throw coupon.error;
  couponId = coupon.data.id;

  const setupResults = await Promise.all([
    service.from("coupon_redemptions").insert({
      coupon_id: couponId,
      clinic_id: clinicId,
      subscription_id: subscriptionId,
      redeemed_at: "2026-07-03T09:00:00.000Z",
    }),
    service.from("clinic_feature_overrides").insert({
      clinic_id: clinicId,
      feature_key: "ai_assistant",
      enabled: true,
    }),
    service.from("clinic_working_hours").insert([
      { clinic_id: clinicId, day_of_week: 0, shift_start: "09:00", shift_end: "13:00" },
      { clinic_id: clinicId, day_of_week: 0, shift_start: "15:00", shift_end: "19:00" },
      { clinic_id: clinicId, day_of_week: 1, shift_start: "09:00", shift_end: "17:00" },
    ]),
    service.from("usage_counters").insert(
      Array.from({ length: 26 }, (_, index) => ({
        clinic_id: clinicId,
        period_start: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
        metric: ["ai_messages", "wa_messages", "sms_messages", "emails"][index % 4] as Database["public"]["Enums"]["usage_metric"],
        used: index,
        limit_snapshot: 100,
      })),
    ),
    service.from("platform_audit_logs").insert([
      {
        action: "subscription.granted",
        target_type: "subscription",
        target_id: subscriptionId,
        clinic_id: clinicId,
        payload: { planSlug: "basic", months: 3 },
        created_at: "2026-07-04T09:00:00.000Z",
      },
      {
        action: "feature_override.upserted",
        target_type: "clinic_feature_override",
        target_id: "ai_assistant",
        clinic_id: clinicId,
        payload: { enabled: true },
        created_at: "2026-07-05T09:00:00.000Z",
      },
      {
        action: "invitation.issued",
        target_type: "clinic_invitation",
        target_id: invitationId,
        payload: { force: true, expiresAt: "2026-07-07T09:00:00.000Z" },
        created_at: "2026-06-30T11:00:00.000Z",
      },
      {
        action: "patient.exported",
        target_type: "patient",
        target_id: "patient-private-id",
        clinic_id: clinicId,
        payload: { patientName: "WS8 Patient PHI", nationalId: "SECRET-NATIONAL-ID" },
        created_at: "2026-07-06T09:00:00.000Z",
      },
    ]),
  ]);
  const setupError = setupResults.map((result) => result.error).find(Boolean);
  if (setupError) throw setupError;
});

beforeEach(() => {
  mocks.requirePlatformAdmin.mockReset();
  mocks.requirePlatformAdmin.mockResolvedValue({ id: "ws8-operator", email: "operator@example.com" });
});

afterAll(async () => {
  await service.from("platform_audit_logs").delete().eq("clinic_id", clinicId);
  await service.from("platform_audit_logs").delete().eq("target_id", invitationId);
  await service.from("coupon_redemptions").delete().eq("clinic_id", clinicId);
  await service.from("clinic_feature_overrides").delete().eq("clinic_id", clinicId);
  await service.from("usage_counters").delete().eq("clinic_id", clinicId);
  await service.from("clinic_working_hours").delete().eq("clinic_id", clinicId);
  await service.from("clinic_invitations").delete().eq("id", invitationId);
  await service.from("coupons").delete().eq("id", couponId);
  await service.from("subscriptions").delete().eq("id", subscriptionId);
  await service.from("clinics").delete().eq("id", clinicId);
});

describe("Pre-P2 WS8 operator clinic history", () => {
  it("loads every approved recorded section and sanitizes the audit-derived timeline", async () => {
    const result = await getOperatorClinicHistory(clinicId, {
      metric: "all",
      page: 1,
      pageSize: 25,
    });
    expect(result.error).toBeNull();
    expect(result.data?.clinic).toEqual(expect.objectContaining({
      id: clinicId,
      currency: "KWD",
      locale: "en",
      timezone: "Asia/Kuwait",
    }));
    expect(result.data?.subscription).toEqual(expect.objectContaining({
      id: subscriptionId,
      provider: "manual",
      status: "active",
    }));
    expect(result.data?.workingHours).toHaveLength(3);
    expect(result.data?.invitations).toEqual([
      expect.objectContaining({ id: invitationId, status: "accepted" }),
    ]);
    expect(result.data?.redemptions).toEqual([
      expect.objectContaining({
        coupon_id: couponId,
        coupons: expect.objectContaining({ kind: "months_free", months: 3 }),
      }),
    ]);
    expect(result.data?.overrides).toEqual([
      expect.objectContaining({ feature_key: "ai_assistant", enabled: true }),
    ]);
    expect(result.data?.usage.total).toBe(26);
    expect(result.data?.usage.rows).toHaveLength(25);
    expect(result.data?.auditEvents.map((event) => event.title)).toEqual(expect.arrayContaining([
      "Manual subscription granted or extended",
      "Feature override changed",
      "Invitation reissued",
    ]));

    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("WS8 Patient PHI");
    expect(serialized).not.toContain("SECRET-NATIONAL-ID");
    expect(serialized).not.toContain("WS8 Private Owner");
    expect(serialized).not.toContain("ws8-private-");
    expect(serialized).not.toContain("+96555555555");
    const keys = allKeys(result.data);
    for (const forbidden of [
      "patient_id",
      "patientName",
      "national_id",
      "nationalId",
      "medical_notes",
      "owner_name",
      "email",
      "phone",
      "token_hash",
      "actor_user_id",
      "payload",
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it("filters and paginates usage at the guarded database boundary", async () => {
    const secondPage = await getOperatorClinicHistory(clinicId, {
      metric: "all",
      page: 2,
      pageSize: 25,
    });
    expect(secondPage.data?.usage).toEqual(expect.objectContaining({
      total: 26,
      page: 2,
      pageCount: 2,
    }));
    expect(secondPage.data?.usage.rows).toHaveLength(1);

    const filtered = await getOperatorClinicHistory(clinicId, {
      metric: "emails",
      page: 1,
      pageSize: 25,
    });
    expect(filtered.data?.usage.total).toBe(6);
    expect(filtered.data?.usage.rows.every((row) => row.metric === "emails")).toBe(true);

    const clamped = await getOperatorClinicHistory(clinicId, {
      metric: "all",
      page: 999,
      pageSize: 25,
    });
    expect(clamped.data?.usage.page).toBe(2);
    expect(clamped.data?.usage.rows).toHaveLength(1);
  });

  it("normalizes invalid usage URL state and re-guards before privileged reads", async () => {
    expect(parseOperatorClinicUsageParams({
      usageMetric: "patients",
      usagePage: "-9",
      usagePageSize: "5000",
    })).toEqual({ metric: "all", page: 1, pageSize: 25 });

    mocks.requirePlatformAdmin.mockRejectedValue(new Error("PLATFORM_ADMIN_REQUIRED"));
    await expect(getOperatorClinicHistory(clinicId, {
      metric: "all",
      page: 1,
      pageSize: 25,
    })).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
  });
});
