import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  persistInbound: vi.fn(),
  advanceStatus: vi.fn(),
  applyTemplateStatus: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  persistWhatsAppInbound: mocks.persistInbound,
  advanceOutboundMessageStatus: mocks.advanceStatus,
  applyMessageTemplateProviderStatus: mocks.applyTemplateStatus,
  createClinicScopedAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: vi.fn() }) }) }),
  }),
}));
vi.mock("@/lib/messaging/meta-reconcile", () => ({
  applyChannelStateSignals: vi.fn().mockResolvedValue({ transitioned: false }),
  refreshConnectionStateAfterTemplateChange: vi.fn().mockResolvedValue({ transitioned: false }),
}));
vi.mock("@/lib/phone/registry", () => ({ normalizePhone: (v: string) => v }));
vi.mock("@/lib/messaging/scrub", () => ({ sanitizeProviderError: (v: unknown) => String(v) }));
vi.mock("@/lib/notifications/emit", () => ({ emitClinicNotification: vi.fn() }));

import { processMessagingWebhookEvents } from "@/lib/messaging/webhooks";

const clinicId = "11111111-1111-4111-8111-111111111111";
const templateDbId = "22222222-2222-4222-8222-222222222222";
const providerTemplateId = "prov-1";

function templateEvent(status: "approved" | "rejected" | "submitted") {
  return {
    kind: "template_status" as const,
    providerTemplateId,
    name: "appointment_reminder",
    language: "ar",
    status,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyTemplateStatus.mockResolvedValue({
    data: [{ template_id: templateDbId, clinic_id: clinicId, changed: true }],
    error: null,
  });
});

describe("persistTemplateStatus transition guard (P3-M3)", () => {
  it("applies an approval, gated on the provider id and legal source states", async () => {
    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId,
      events: [templateEvent("approved")],
    });
    expect(summary.templates).toBe(1);
    expect(mocks.applyTemplateStatus).toHaveBeenCalledWith({
      provider: "dialog360",
      providerTemplateId,
      status: "approved",
      allowedFrom: ["submitted", "rejected"],
    });
  });

  it("safely ignores a stale event that matches no legal source row", async () => {
    // The conditional UPDATE affects nothing (e.g. template edited back to
    // draft and provider id detached): a no-op, not an error.
    mocks.applyTemplateStatus.mockResolvedValue({ data: [], error: null });
    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId,
      events: [templateEvent("approved")],
    });
    expect(summary.templates).toBe(0);
    expect(summary.ignored).toBe(1);
  });

  it("rejects an event for a template owned by another clinic", async () => {
    mocks.applyTemplateStatus.mockResolvedValue({
      data: [{
        template_id: templateDbId,
        clinic_id: "99999999-9999-4999-8999-999999999999",
        changed: true,
      }],
      error: null,
    });
    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId,
      events: [templateEvent("approved")],
    });
    expect(summary.templates).toBe(0);
    expect(mocks.applyTemplateStatus).toHaveBeenCalledOnce();
  });

  it("fails the callback when the atomic status+audit RPC fails", async () => {
    mocks.applyTemplateStatus.mockResolvedValue({
      data: null,
      error: { message: "audit insert failed" },
    });
    await expect(
      processMessagingWebhookEvents({
        provider: "dialog360",
        clinicId,
        events: [templateEvent("approved")],
      }),
    ).rejects.toThrow("TEMPLATE_STATUS_UPDATE_FAILED");
  });
});
