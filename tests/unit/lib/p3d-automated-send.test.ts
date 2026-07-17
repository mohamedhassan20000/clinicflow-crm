import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock("@/lib/messaging/send", () => ({
  sendMessage: mocks.sendMessage,
}));

import { sendAutomatedPatientMessage } from "@/lib/messaging/automated-send";

const baseInput = {
  clinicId: "11111111-1111-4111-8111-111111111111",
  recipient: {
    phone: "+96550000001",
    email: "patient@example.com",
  },
  locale: "en" as const,
  whatsappTemplates: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "appointment_reminder",
      language: "en",
      variables: ["patient_name"],
      approval_status: "approved" as const,
      channel: "whatsapp" as const,
    },
  ],
  templateValues: {
    patient_name: "Sara",
    clinic_name: "Clinic A",
    doctor_name: "Dr. Ali",
    appointment_date: "18 July 2026",
    appointment_time: "10:00",
  },
  subject: "Appointment reminder",
  body: "Your appointment is tomorrow.",
  relatedType: "appointment" as const,
  relatedId: "33333333-3333-4333-8333-333333333333",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sendAutomatedPatientMessage", () => {
  it("tries WhatsApp first and Email second when WhatsApp cannot send", async () => {
    mocks.sendMessage
      .mockResolvedValueOnce({ ok: false, code: "USAGE_LIMIT_REACHED" })
      .mockResolvedValueOnce({ ok: true, channel: "email" });

    await expect(sendAutomatedPatientMessage(baseInput)).resolves.toEqual({
      ok: true,
      channel: "email",
    });
    expect(mocks.sendMessage.mock.calls).toHaveLength(2);
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({
      recipient: "+96550000001",
      channelPreference: ["whatsapp"],
      templateId: "22222222-2222-4222-8222-222222222222",
    });
    expect(mocks.sendMessage.mock.calls[1][0]).toMatchObject({
      recipient: "patient@example.com",
      channelPreference: ["email"],
      subject: "Appointment reminder",
    });
  });

  it("uses Email directly when no WhatsApp template or phone is available", async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, channel: "email" });

    await sendAutomatedPatientMessage({
      ...baseInput,
      recipient: { phone: null, email: "patient@example.com" },
      whatsappTemplates: [],
    });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channelPreference: ["email"] }),
    );
  });

  it("stops after a successful WhatsApp send", async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true, channel: "whatsapp" });

    await expect(sendAutomatedPatientMessage(baseInput)).resolves.toEqual({
      ok: true,
      channel: "whatsapp",
    });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
  });

  it("falls back to Email on a definite WhatsApp failure", async () => {
    mocks.sendMessage
      .mockResolvedValueOnce({ ok: false, code: "PROVIDER_SEND_FAILED" })
      .mockResolvedValueOnce({ ok: true, channel: "email" });

    await expect(sendAutomatedPatientMessage(baseInput)).resolves.toEqual({
      ok: true,
      channel: "email",
    });
    expect(mocks.sendMessage.mock.calls).toHaveLength(2);
  });

  it("does NOT fall back to Email on an ambiguous WhatsApp outcome (P3-M1)", async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      ok: false,
      code: "PROVIDER_SEND_AMBIGUOUS",
    });

    await expect(sendAutomatedPatientMessage(baseInput)).resolves.toEqual({
      ok: false,
      code: "PROVIDER_SEND_AMBIGUOUS",
    });
    // Stopped after WhatsApp — Email is never attempted, so no duplicate.
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({
      channelPreference: ["whatsapp"],
    });
  });
});
