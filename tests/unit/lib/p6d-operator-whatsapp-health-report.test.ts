import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  loadHealth: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));
vi.mock("@/lib/supabase/admin", () => ({
  loadOperatorWhatsAppHealthReport: mocks.loadHealth,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { operatorReportRegistry } from "@/lib/operator-reports/registry";
import { parseReportParams } from "@/lib/operator-reports/types";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePlatformAdmin.mockResolvedValue({ id: "operator" });
  mocks.loadHealth.mockResolvedValue({
    data: [
      {
        clinic_id: "11111111-1111-4111-8111-111111111111",
        clinic_name: "Clinic A",
        channel_id: "channel-a",
        provider: "meta",
        channel_status: "active",
        connection_state: "connected",
        webhook_health_status: "healthy",
        last_verified_webhook_at: "2026-07-28T12:00:00.000Z",
        last_webhook_check_at: "2026-07-28T11:00:00.000Z",
        last_synced_at: "2026-07-28T10:00:00.000Z",
        business_verification_status: null,
        account_review_status: "APPROVED",
        phone_status: "VERIFIED",
        quality_rating: "GREEN",
        messaging_limit_tier: "TIER_1K",
        approved_templates: 2,
        last_inbound_at: "2026-07-28T09:00:00.000Z",
        last_outbound_at: "2026-07-28T09:30:00.000Z",
        last_outbound_status: "delivered",
      },
      {
        clinic_id: "22222222-2222-4222-8222-222222222222",
        clinic_name: "Clinic B",
        channel_id: "channel-b",
        provider: "dialog360",
        channel_status: "active",
        connection_state: null,
        webhook_health_status: "degraded",
        last_verified_webhook_at: null,
        last_webhook_check_at: "2026-07-28T11:00:00.000Z",
        last_synced_at: null,
        business_verification_status: null,
        account_review_status: null,
        phone_status: null,
        quality_rating: null,
        messaging_limit_tier: null,
        approved_templates: 0,
        last_inbound_at: null,
        last_outbound_at: null,
        last_outbound_status: null,
      },
    ],
    error: null,
  });
});

describe("P6D operator WhatsApp health registry report", () => {
  it("filters provider/health through the shared registry and stays content-free", async () => {
    const definition = operatorReportRegistry.get("whatsapp-health")!;
    const params = parseReportParams(definition, {
      clinic: "all",
      provider: "dialog360",
      health: "degraded",
      sort: "clinic_name",
      dir: "asc",
    });
    const result = await definition.query(params);

    expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();
    expect(result.rows).toEqual([
      expect.objectContaining({
        clinic_name: "Clinic B",
        provider: "dialog360",
        webhook_health: "degraded",
        quality_rating: "not_available",
        messaging_limit: "not_available",
      }),
    ]);
    const serialized = JSON.stringify(result.rows);
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("recipient");
    expect(serialized).not.toContain("sender");
    expect(serialized).not.toContain("credential");
  });
});
