import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(),
  getSettings: vi.fn(),
  dispatch: vi.fn(),
  waActive: vi.fn(),
  emit: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  tables: {} as Record<string, { data: unknown; error: unknown }>,
}));

function tableChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "order", "limit"]) {
    chain[method] = () => chain;
  }
  chain.then = (resolve: (value: unknown) => unknown) => resolve(result);
  return chain;
}

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  captureException: mocks.captureException,
}));
vi.mock("@/lib/supabase/admin", () => ({
  listDailyReminderCandidates: mocks.listCandidates,
  getClinicReminderSettings: mocks.getSettings,
  createClinicScopedAdminClient: () => ({
    from: (table: string) =>
      tableChain(mocks.tables[table] ?? { data: [], error: null }),
  }),
}));
vi.mock("@/lib/messaging/automated-send", () => ({
  dispatchPatientMessage: mocks.dispatch,
  anyChannelSent: (r: { email?: { status: string }; whatsapp?: { status: string } }) =>
    r?.email?.status === "sent" || r?.whatsapp?.status === "sent",
  anyChannelFailed: (r: { email?: { status: string }; whatsapp?: { status: string } }) =>
    r?.email?.status === "failed" || r?.whatsapp?.status === "failed",
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  hasActiveWhatsAppChannel: mocks.waActive,
}));
vi.mock("@/lib/notifications/emit", () => ({
  emitClinicNotification: mocks.emit,
}));

import { runAppointmentReminders } from "@/lib/messaging/reminders";

const clinicId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "22222222-2222-4222-8222-222222222222";
const patientId = "33333333-3333-4333-8333-333333333333";
const doctorId = "44444444-4444-4444-8444-444444444444";

const now = new Date("2026-07-17T06:00:00.000Z");

function candidate(overrides: Partial<{ scheduled_at: string }> = {}) {
  return {
    id: appointmentId,
    clinic_id: clinicId,
    patient_id: patientId,
    doctor_id: doctorId,
    scheduled_at: overrides.scheduled_at ?? "2026-07-17T12:00:00.000Z",
    reminders_sent: {},
    timezone: "Asia/Kuwait",
  };
}

const sentResult = {
  email: { status: "sent" },
  whatsapp: { status: "not_attempted", reason: "no_whatsapp_channel" },
};

beforeEach(() => {
  mocks.getSettings.mockResolvedValue({
    data: {
      id: clinicId,
      name: "Clinic A",
      timezone: "Asia/Kuwait",
      locale: "ar",
      time_format: "24h",
      digits: "latin",
      currency: "KWD",
      reminders_enabled: true,
    },
    error: null,
  });
  mocks.tables.message_templates = { data: [], error: null };
  mocks.tables.patients = {
    data: [{ id: patientId, full_name: "Sara", phone: "+96550000001", email: "sara@example.com" }],
    error: null,
  };
  mocks.tables.profiles = {
    data: [{ id: doctorId, full_name: "Dr. Ali" }],
    error: null,
  };
  mocks.waActive.mockResolvedValue(false);
  mocks.dispatch.mockResolvedValue(sentResult);
  mocks.emit.mockResolvedValue({ created: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runAppointmentReminders (daily model, independent channels)", () => {
  it("dispatches one reminder per appointment with the per-appointment dedupe key", async () => {
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ appointments: 1, sent: 1, failed: 0 });
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    const input = mocks.dispatch.mock.calls[0][0];
    expect(input).toMatchObject({
      clinicId,
      dedupeKey: `appointment_reminder:${appointmentId}`,
      relatedType: "appointment",
      relatedId: appointmentId,
      locale: "ar",
      whatsappActive: false,
    });
    expect(input.recipient).toEqual({ phone: "+96550000001", email: "sara@example.com" });
  });

  it("selects candidates within the today+tomorrow horizon", async () => {
    mocks.listCandidates.mockResolvedValue({ data: [], error: null });
    await runAppointmentReminders(now);
    const [nowIso, horizonIso] = mocks.listCandidates.mock.calls[0];
    expect(nowIso).toBe(now.toISOString());
    expect(new Date(horizonIso).getTime() - now.getTime()).toBe(2 * 86_400_000);
  });

  it("skips (no dispatch) when the patient row is missing", async () => {
    mocks.tables.patients = { data: [], error: null };
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("counts a fully-deduped run as skipped without alerting", async () => {
    mocks.dispatch.mockResolvedValue({
      email: { status: "duplicate" },
      whatsapp: { status: "not_attempted", reason: "no_whatsapp_channel" },
    });
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ sent: 0, failed: 0, skipped: 1 });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("notifies clinic admins when a channel definitely fails and nothing sent", async () => {
    mocks.dispatch.mockResolvedValue({
      email: { status: "failed", code: "PROVIDER_SEND_FAILED" },
      whatsapp: { status: "not_attempted", reason: "no_whatsapp_channel" },
    });
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(mocks.emit).toHaveBeenCalledOnce();
    expect(mocks.emit.mock.calls[0][0]).toMatchObject({
      clinicId,
      type: "reminder_failed",
      roles: ["admin"],
      dedupeUnread: true,
      dedupeData: { appointmentId },
    });
  });

  it("stays silent (skipped) when the only outcome is ambiguous", async () => {
    mocks.dispatch.mockResolvedValue({
      email: { status: "ambiguous" },
      whatsapp: { status: "not_attempted", reason: "no_whatsapp_channel" },
    });
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ sent: 0, failed: 0, skipped: 1 });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("passes the approved WhatsApp template + values through to dispatch", async () => {
    const template = {
      id: "55555555-5555-4555-8555-555555555555",
      name: "appointment_reminder",
      language: "ar",
      variables: ["patient_name", "appointment_date"],
      approval_status: "approved",
      channel: "whatsapp",
    };
    mocks.tables.message_templates = { data: [template], error: null };
    mocks.waActive.mockResolvedValue(true);
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    await runAppointmentReminders(now);
    const input = mocks.dispatch.mock.calls[0][0];
    expect(input.whatsappActive).toBe(true);
    expect(input.whatsappTemplates).toEqual([template]);
    expect(input.templateValues).toMatchObject({
      patient_name: "Sara",
      clinic_name: "Clinic A",
      doctor_name: "Dr. Ali",
    });
  });
});
