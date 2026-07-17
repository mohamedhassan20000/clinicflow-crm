import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCandidates: vi.fn(),
  getSettings: vi.fn(),
  claim: vi.fn(),
  finalize: vi.fn(),
  release: vi.fn(),
  send: vi.fn(),
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
  listReminderCandidateAppointments: mocks.listCandidates,
  getClinicReminderSettings: mocks.getSettings,
  claimAppointmentReminder: mocks.claim,
  finalizeAppointmentReminder: mocks.finalize,
  releaseAppointmentReminder: mocks.release,
  createClinicScopedAdminClient: () => ({
    from: (table: string) =>
      tableChain(mocks.tables[table] ?? { data: [], error: null }),
  }),
}));
vi.mock("@/lib/messaging/automated-send", () => ({
  sendAutomatedPatientMessage: mocks.send,
}));
vi.mock("@/lib/notifications/emit", () => ({
  emitClinicNotification: mocks.emit,
}));

import { runAppointmentReminders } from "@/lib/messaging/reminders";

const clinicId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "22222222-2222-4222-8222-222222222222";
const patientId = "33333333-3333-4333-8333-333333333333";
const doctorId = "44444444-4444-4444-8444-444444444444";

const now = new Date("2026-07-17T10:00:00.000Z");

function candidate(overrides: Partial<{
  scheduled_at: string;
  reminders_sent: Record<string, unknown>;
}> = {}) {
  return {
    id: appointmentId,
    clinic_id: clinicId,
    patient_id: patientId,
    doctor_id: doctorId,
    // 2 hours out: both the 24h and the 3h offsets are due.
    scheduled_at: overrides.scheduled_at ?? "2026-07-17T12:00:00.000Z",
    reminders_sent: overrides.reminders_sent ?? {},
  };
}

/** A finalized "sent" lease entry, matching the RPC's stored shape. */
function sent(at: string) {
  return { state: "sent", at };
}
/** A "claimed" lease entry from an in-flight or crashed run. */
function claimed(at: string) {
  return { state: "claimed", at };
}

beforeEach(() => {
  mocks.getSettings.mockResolvedValue({
    data: {
      id: clinicId,
      name: "Clinic A",
      timezone: "Asia/Kuwait",
      locale: "ar",
      time_format: "24h",
      digits: "latin",
      reminder_offsets: [24, 3],
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
  mocks.claim.mockResolvedValue({ data: true, error: null });
  mocks.finalize.mockResolvedValue({ data: true, error: null });
  mocks.release.mockResolvedValue({ data: true, error: null });
  mocks.send.mockResolvedValue({ ok: true, channel: "email" });
  mocks.emit.mockResolvedValue({ created: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runAppointmentReminders", () => {
  it("claims every due offset but sends exactly one message", async () => {
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ appointments: 1, sent: 1, failed: 0 });
    expect(mocks.claim).toHaveBeenCalledTimes(2);
    expect(mocks.claim.mock.calls.map(([input]) => input.offsetHours).sort((a, b) => a - b)).toEqual([3, 24]);
    expect(mocks.send).toHaveBeenCalledOnce();
    // Only a successful dispatch finalizes the claimed leases to "sent".
    expect(mocks.finalize).toHaveBeenCalledTimes(2);
    expect(mocks.release).not.toHaveBeenCalled();
    const sendInput = mocks.send.mock.calls[0][0];
    expect(sendInput).toMatchObject({
      clinicId,
      relatedType: "appointment",
      relatedId: appointmentId,
      locale: "ar",
    });
    expect(sendInput.recipient).toEqual({ phone: "+96550000001", email: "sara@example.com" });
  });

  it("skips offsets already finalized as sent (idempotency)", async () => {
    mocks.listCandidates.mockResolvedValue({
      data: [candidate({ reminders_sent: { "24": sent("2026-07-16T12:00:00.000Z") } })],
      error: null,
    });
    await runAppointmentReminders(now);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim.mock.calls[0][0].offsetHours).toBe(3);
  });

  it("treats a legacy bare-string marker as sent", async () => {
    mocks.listCandidates.mockResolvedValue({
      data: [candidate({ reminders_sent: { "24": "2026-07-16T12:00:00.000Z" } })],
      error: null,
    });
    await runAppointmentReminders(now);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim.mock.calls[0][0].offsetHours).toBe(3);
  });

  it("does not re-attempt an offset under a fresh claim from a concurrent run", async () => {
    mocks.listCandidates.mockResolvedValue({
      data: [candidate({ reminders_sent: { "3": claimed(now.toISOString()) } })],
      error: null,
    });
    await runAppointmentReminders(now);
    // Only the 24h offset is actionable; the fresh 3h claim is left alone.
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.claim.mock.calls[0][0].offsetHours).toBe(24);
  });

  it("recovers a stale claim left by a crashed run (past the lease window)", async () => {
    // Claimed 20 minutes ago (> 15-minute lease) and never finalized.
    const staleAt = new Date(now.getTime() - 20 * 60_000).toISOString();
    mocks.listCandidates.mockResolvedValue({
      data: [candidate({ reminders_sent: { "3": claimed(staleAt) } })],
      error: null,
    });
    const summary = await runAppointmentReminders(now);
    // Both offsets are actionable again — the stale 3h claim is re-claimed.
    expect(mocks.claim.mock.calls.map(([input]) => input.offsetHours).sort((a, b) => a - b)).toEqual([3, 24]);
    expect(summary.sent).toBe(1);
  });

  it("does nothing for appointments outside every offset window", async () => {
    mocks.listCandidates.mockResolvedValue({
      data: [candidate({ scheduled_at: "2026-07-18T16:00:00.000Z" })],
      error: null,
    });
    const summary = await runAppointmentReminders(now);
    expect(summary.sent).toBe(0);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not send when another run already claimed the offsets", async () => {
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    mocks.claim.mockResolvedValue({ data: false, error: null });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ sent: 0, skipped: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("releases the claims and notifies clinic admins when every channel fails", async () => {
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    mocks.send.mockResolvedValue({ ok: false, code: "PROVIDER_SEND_FAILED" });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(mocks.release).toHaveBeenCalledTimes(2);
    expect(mocks.emit).toHaveBeenCalledOnce();
    expect(mocks.emit.mock.calls[0][0]).toMatchObject({
      clinicId,
      type: "reminder_failed",
      roles: ["admin"],
      dedupeUnread: true,
      dedupeData: { appointmentId },
    });
  });

  it("keeps the claim and stays silent on an ambiguous provider outcome", async () => {
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    mocks.send.mockResolvedValue({ ok: false, code: "PROVIDER_SEND_AMBIGUOUS" });
    const summary = await runAppointmentReminders(now);
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    // The message may have gone out: do not release (keeps the lease) and do
    // not alert admins. The stale claim will retry after the lease if lost.
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("passes the approved clinic-language WhatsApp reminder template through to dispatch", async () => {
    const template = {
      id: "55555555-5555-4555-8555-555555555555",
      name: "appointment_reminder",
      language: "ar",
      variables: ["patient_name", "appointment_date"],
      approval_status: "approved",
      channel: "whatsapp",
    };
    mocks.tables.message_templates = { data: [template], error: null };
    mocks.listCandidates.mockResolvedValue({ data: [candidate()], error: null });
    await runAppointmentReminders(now);
    expect(mocks.send.mock.calls[0][0].whatsappTemplates).toEqual([template]);
    expect(mocks.send.mock.calls[0][0].templateValues).toMatchObject({
      patient_name: "Sara",
      clinic_name: "Clinic A",
      doctor_name: "Dr. Ali",
    });
  });
});
