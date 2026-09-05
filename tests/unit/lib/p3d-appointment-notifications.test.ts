import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  send: vi.fn(),
  waProvider: vi.fn(),
  captureException: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: unknown }>,
}));

function tableChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "order", "limit"]) {
    chain[method] = () => chain;
  }
  chain.maybeSingle = async () => result;
  chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
  return chain;
}

vi.mock("@sentry/nextjs", () => ({ captureException: mocks.captureException }));
vi.mock("@/lib/supabase/admin", () => ({
  getClinicReminderSettings: mocks.getSettings,
  createClinicScopedAdminClient: () => ({
    from: (table: string) =>
      tableChain(mocks.tables[table] ?? { data: null, error: null }),
  }),
}));
vi.mock("@/lib/messaging/automated-send", () => ({
  AUTOMATED_TEMPLATE_APPROVAL_STATES: ["approved", "submitted", "draft"],
  dispatchPatientMessage: mocks.send,
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  getActiveWhatsAppProvider: mocks.waProvider,
}));

import { notifyAppointmentEvent } from "@/lib/messaging/appointment-notifications";
import { APPOINTMENT_EVENT_TEMPLATE_NAME } from "@/lib/messaging/patient-copy";

const clinicId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "22222222-2222-4222-8222-222222222222";
const patientId = "33333333-3333-4333-8333-333333333333";
const doctorId = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  mocks.tables.appointments = {
    data: {
      id: appointmentId,
      patient_id: patientId,
      doctor_id: doctorId,
      scheduled_at: "2026-07-17T12:00:00.000Z",
    },
    error: null,
  };
  mocks.tables.patients = {
    data: { id: patientId, full_name: "Sara", phone: "+96550000001", email: "sara@example.com" },
    error: null,
  };
  mocks.tables.profiles = { data: { id: doctorId, full_name: "Dr. Ali" }, error: null };
  mocks.tables.message_templates = { data: [], error: null };
  mocks.getSettings.mockResolvedValue({
    data: {
      id: clinicId,
      name: "Clinic A",
      timezone: "Asia/Kuwait",
      locale: "en",
      time_format: "24h",
      digits: "latin",
      currency: "KWD",
      reminders_enabled: true,
    },
    error: null,
  });
  mocks.waProvider.mockResolvedValue("meta");
  mocks.send.mockResolvedValue({
    email: { status: "sent" },
    whatsapp: { status: "sent" },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("notifyAppointmentEvent", () => {
  it.each(["created", "confirmed", "rescheduled", "cancelled"] as const)(
    "dispatches an immediate patient message for the %s event",
    async (event) => {
      await notifyAppointmentEvent({ clinicId, appointmentId, event });
      expect(mocks.send).toHaveBeenCalledOnce();
      const input = mocks.send.mock.calls[0][0];
      expect(input).toMatchObject({
        clinicId,
        dedupeKey: `appointment:${event}:${appointmentId}`,
        relatedType: "appointment",
        relatedId: appointmentId,
        locale: "en",
        whatsappActive: true,
      });
      expect(input.recipient).toEqual({ phone: "+96550000001", email: "sara@example.com" });
      expect(input.subject).toContain("Clinic A");
      expect(input.body).toContain("Sara");
    },
  );

  it("looks up the approved WhatsApp template named for the event", async () => {
    const template = {
      id: "55555555-5555-4555-8555-555555555555",
      name: APPOINTMENT_EVENT_TEMPLATE_NAME.confirmed,
      language: "en",
      variables: ["patient_name"],
      approval_status: "approved",
      channel: "whatsapp",
    };
    mocks.tables.message_templates = { data: [template], error: null };
    await notifyAppointmentEvent({ clinicId, appointmentId, event: "confirmed" });
    expect(mocks.send.mock.calls[0][0].whatsappTemplates).toEqual([template]);
  });

  it("never throws and does not send when the appointment is missing", async () => {
    mocks.tables.appointments = { data: null, error: null };
    await expect(
      notifyAppointmentEvent({ clinicId, appointmentId, event: "created" }),
    ).resolves.toBeUndefined();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("swallows unexpected errors (best-effort, never fails the action)", async () => {
    mocks.getSettings.mockRejectedValueOnce(new Error("boom"));
    await expect(
      notifyAppointmentEvent({ clinicId, appointmentId, event: "created" }),
    ).resolves.toBeUndefined();
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });
});
