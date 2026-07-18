import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  claim: vi.fn(),
  finalize: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/messaging/send", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("@/lib/supabase/admin", () => ({
  claimMessageDispatch: mocks.claim,
  finalizeMessageDispatch: mocks.finalize,
  releaseMessageDispatch: mocks.release,
}));

import { dispatchPatientMessage } from "@/lib/messaging/automated-send";

const baseInput = {
  clinicId: "11111111-1111-4111-8111-111111111111",
  dedupeKey: "invoice:33333333-3333-4333-8333-333333333333",
  recipient: {
    phone: "+96550000001",
    email: "patient@example.com",
  },
  locale: "en" as const,
  whatsappActive: true,
  whatsappTemplates: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "invoice_issued",
      language: "en",
      variables: ["patient_name"],
      approval_status: "approved" as const,
      channel: "whatsapp" as const,
    },
  ],
  templateValues: {
    patient_name: "Sara",
    clinic_name: "Clinic A",
  },
  subject: "Invoice",
  body: "Your invoice.",
  relatedType: "invoice" as const,
  relatedId: "33333333-3333-4333-8333-333333333333",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue({ data: true, error: null });
  mocks.finalize.mockResolvedValue({ data: true, error: null });
  mocks.release.mockResolvedValue({ data: true, error: null });
});

describe("dispatchPatientMessage (independent channels + idempotency)", () => {
  it("sends Email and WhatsApp independently, both claimed and finalized", async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "om-1" });

    const result = await dispatchPatientMessage(baseInput);
    expect(result.email?.status).toBe("sent");
    expect(result.whatsapp?.status).toBe("sent");
    expect(mocks.sendMessage.mock.calls).toHaveLength(2);
    expect(mocks.claim.mock.calls.map(([c]) => c.channel).sort()).toEqual([
      "email",
      "whatsapp",
    ]);
    expect(mocks.finalize.mock.calls).toHaveLength(2);
  });

  it("always sends Email even when the clinic has no WhatsApp integration", async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "om-1" });

    const result = await dispatchPatientMessage({ ...baseInput, whatsappActive: false });
    expect(result.email?.status).toBe("sent");
    expect(result.whatsapp).toEqual({
      status: "not_attempted",
      reason: "no_whatsapp_channel",
    });
    // Only the email channel was dispatched.
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({
      channelPreference: ["email"],
    });
  });

  it("one channel failing never blocks the other; only the failed channel is released", async () => {
    // Email fails, WhatsApp succeeds (order: email first, then whatsapp).
    mocks.sendMessage
      .mockResolvedValueOnce({ ok: false, code: "PROVIDER_SEND_FAILED" })
      .mockResolvedValueOnce({ ok: true, outboundMessageId: "om-2" });

    const result = await dispatchPatientMessage(baseInput);
    expect(result.email?.status).toBe("failed");
    expect(result.whatsapp?.status).toBe("sent");
    // The failed channel's claim is released for retry; the sent one is finalized.
    expect(mocks.release.mock.calls[0][0]).toMatchObject({ channel: "email" });
    expect(mocks.finalize.mock.calls[0][0]).toMatchObject({ channel: "whatsapp" });
  });

  it("skips a channel whose claim is denied (already sent) — no duplicate", async () => {
    // Email already sent (claim denied); WhatsApp still open.
    mocks.claim
      .mockResolvedValueOnce({ data: false, error: null }) // email
      .mockResolvedValueOnce({ data: true, error: null }); // whatsapp
    mocks.sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "om-3" });

    const result = await dispatchPatientMessage(baseInput);
    expect(result.email?.status).toBe("duplicate");
    expect(result.whatsapp?.status).toBe("sent");
    // Only WhatsApp actually dispatched.
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps the claim (no release) on an ambiguous provider outcome", async () => {
    mocks.sendMessage.mockResolvedValue({ ok: false, code: "PROVIDER_SEND_AMBIGUOUS" });

    const result = await dispatchPatientMessage({
      ...baseInput,
      recipient: { phone: null, email: "patient@example.com" },
      whatsappActive: false,
    });
    expect(result.email?.status).toBe("ambiguous");
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("does not attempt WhatsApp when no approved template exists", async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, outboundMessageId: "om-4" });

    const result = await dispatchPatientMessage({ ...baseInput, whatsappTemplates: [] });
    expect(result.email?.status).toBe("sent");
    expect(result.whatsapp).toEqual({ status: "not_attempted", reason: "no_template" });
  });
});
