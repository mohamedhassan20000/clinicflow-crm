import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findTemplate: vi.fn(),
  persistInbound: vi.fn(),
  advanceStatus: vi.fn(),
  updateResult: { data: null as unknown, error: null as unknown },
  updates: [] as Array<{ payload: unknown; filters: unknown[] }>,
}));

vi.mock("@/lib/supabase/admin", () => ({
  findMessageTemplateForWebhook: mocks.findTemplate,
  persistWhatsAppInbound: mocks.persistInbound,
  advanceOutboundMessageStatus: mocks.advanceStatus,
  createClinicScopedAdminClient: () => ({
    from: () => {
      const filters: unknown[] = [];
      const chain: Record<string, unknown> = {
        update: (payload: unknown) => {
          mocks.updates.push({ payload, filters });
          return chain;
        },
        eq: (...args: unknown[]) => {
          filters.push(["eq", ...args]);
          return chain;
        },
        in: (...args: unknown[]) => {
          filters.push(["in", ...args]);
          return chain;
        },
        select: () => chain,
        maybeSingle: () => Promise.resolve(mocks.updateResult),
      };
      return chain;
    },
  }),
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
  mocks.updates = [];
  mocks.updateResult = { data: { id: templateDbId }, error: null };
  mocks.findTemplate.mockResolvedValue({
    data: { id: templateDbId, clinic_id: clinicId },
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
    const update = mocks.updates[0];
    expect(update.payload).toMatchObject({ approval_status: "approved" });
    // Guarded on provider_template_id and legal source states (submitted/rejected).
    const filters = JSON.stringify(update.filters);
    expect(filters).toContain(providerTemplateId);
    expect(filters).toContain("submitted");
    expect(filters).toContain("rejected");
  });

  it("safely ignores a stale event that matches no legal source row", async () => {
    // The conditional UPDATE affects nothing (e.g. template edited back to
    // draft and provider id detached): a no-op, not an error.
    mocks.updateResult = { data: null, error: null };
    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId,
      events: [templateEvent("approved")],
    });
    expect(summary.templates).toBe(0);
    expect(summary.ignored).toBe(1);
  });

  it("rejects an event for a template owned by another clinic", async () => {
    mocks.findTemplate.mockResolvedValue({
      data: { id: templateDbId, clinic_id: "99999999-9999-4999-8999-999999999999" },
      error: null,
    });
    const summary = await processMessagingWebhookEvents({
      provider: "dialog360",
      clinicId,
      events: [templateEvent("approved")],
    });
    expect(summary.templates).toBe(0);
    expect(mocks.updates).toHaveLength(0);
  });
});
