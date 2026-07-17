import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type QueryResult = { data: unknown; error: unknown };

const mocks = vi.hoisted(() => ({
  listDue: vi.fn(),
  getSettings: vi.fn(),
  send: vi.fn(),
  emit: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  results: {} as Record<string, QueryResult[]>,
  updates: [] as { table: string; payload: Record<string, unknown> }[],
  upserts: [] as { table: string; payload: Record<string, unknown>; options: unknown }[],
}));

function nextResult(table: string): QueryResult {
  const queue = mocks.results[table] ?? [];
  return queue.shift() ?? { data: null, error: null };
}

function tableChain(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "is", "order", "limit"]) {
    chain[method] = () => chain;
  }
  chain.update = (payload: Record<string, unknown>) => {
    mocks.updates.push({ table, payload });
    return chain;
  };
  chain.upsert = (payload: Record<string, unknown>, options: unknown) => {
    mocks.upserts.push({ table, payload, options });
    return chain;
  };
  chain.maybeSingle = async () => nextResult(table);
  chain.then = (resolve: (value: unknown) => unknown) => resolve(nextResult(table));
  return chain;
}

vi.mock("@sentry/nextjs", () => ({
  captureMessage: mocks.captureMessage,
  captureException: mocks.captureException,
}));
vi.mock("@/lib/supabase/admin", () => ({
  listDueFollowupSequences: mocks.listDue,
  getClinicReminderSettings: mocks.getSettings,
  createClinicScopedAdminClient: () => ({ from: tableChain }),
}));
vi.mock("@/lib/messaging/automated-send", () => ({
  sendAutomatedPatientMessage: mocks.send,
}));
vi.mock("@/lib/notifications/emit", () => ({
  emitClinicNotification: mocks.emit,
}));

import {
  ensureInvoiceFollowupSequence,
  runInvoiceFollowups,
} from "@/lib/messaging/followups";

const clinicId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "22222222-2222-4222-8222-222222222222";
const patientId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-07-17T10:00:00.000Z");

function sequence(step = 0) {
  return {
    id: "66666666-6666-4666-8666-666666666666",
    clinic_id: clinicId,
    appointment_id: appointmentId,
    step,
    next_run_at: now.toISOString(),
    status: "active",
    created_at: "2026-07-17T09:00:00.000Z",
  };
}

function appointmentRow(overrides: Partial<{
  status: string;
  deleted_at: string | null;
  outstanding_amount: number | null;
}> = {}) {
  return {
    id: appointmentId,
    status: overrides.status ?? "completed",
    deleted_at: overrides.deleted_at ?? null,
    outstanding_amount: overrides.outstanding_amount ?? 40,
    patient_id: patientId,
  };
}

beforeEach(() => {
  mocks.results = {};
  mocks.updates = [];
  mocks.upserts = [];
  mocks.getSettings.mockResolvedValue({
    data: { id: clinicId, name: "Clinic A", timezone: "Asia/Kuwait", locale: "en", time_format: "24h", digits: "latin", reminder_offsets: [24, 3] },
    error: null,
  });
  mocks.send.mockResolvedValue({ ok: true, channel: "email" });
  mocks.emit.mockResolvedValue({ created: 1 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runInvoiceFollowups", () => {
  it("stops the sequence when the outstanding amount is settled, without sending", async () => {
    mocks.listDue.mockResolvedValue({ data: [sequence(1)], error: null });
    mocks.results.appointments = [{ data: appointmentRow({ outstanding_amount: 0 }), error: null }];
    mocks.results.followup_sequences = [{ data: { id: sequence().id }, error: null }];
    const summary = await runInvoiceFollowups(now);
    expect(summary).toMatchObject({ stopped: 1, sent: 0 });
    expect(mocks.updates[0].payload).toMatchObject({ status: "stopped", stopped_reason: "settled" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("stops the sequence when the appointment was cancelled", async () => {
    mocks.listDue.mockResolvedValue({ data: [sequence(0)], error: null });
    mocks.results.appointments = [{ data: appointmentRow({ status: "cancelled" }), error: null }];
    mocks.results.followup_sequences = [{ data: { id: sequence().id }, error: null }];
    const summary = await runInvoiceFollowups(now);
    expect(summary.stopped).toBe(1);
    expect(mocks.updates[0].payload).toMatchObject({ status: "stopped", stopped_reason: "cancelled" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("claims the D0 step, schedules D+3 from the invoice date, and sends", async () => {
    mocks.listDue.mockResolvedValue({ data: [sequence(0)], error: null });
    mocks.results.appointments = [{ data: appointmentRow(), error: null }];
    mocks.results.followup_sequences = [{ data: { id: sequence().id }, error: null }];
    mocks.results.patients = [{ data: { id: patientId, full_name: "Sara", phone: "+96550000001", email: "sara@example.com" }, error: null }];
    const summary = await runInvoiceFollowups(now);
    expect(summary).toMatchObject({ sent: 1, stopped: 0, failed: 0 });
    const claim = mocks.updates.find((update) => update.table === "followup_sequences");
    expect(claim?.payload).toMatchObject({ step: 1 });
    // Anchored on created_at (2026-07-17T09:00Z) + 3 days.
    expect(claim?.payload.next_run_at).toBe("2026-07-20T09:00:00.000Z");
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      clinicId,
      relatedType: "invoice",
      relatedId: appointmentId,
    });
  });

  it("stops with reason completed after the third message", async () => {
    mocks.listDue.mockResolvedValue({ data: [sequence(2)], error: null });
    mocks.results.appointments = [{ data: appointmentRow(), error: null }];
    mocks.results.followup_sequences = [{ data: { id: sequence().id }, error: null }];
    mocks.results.patients = [{ data: { id: patientId, full_name: "Sara", phone: "+96550000001", email: "sara@example.com" }, error: null }];
    const summary = await runInvoiceFollowups(now);
    expect(summary.sent).toBe(1);
    const claim = mocks.updates.find((update) => update.table === "followup_sequences");
    expect(claim?.payload).toMatchObject({
      step: 3,
      status: "stopped",
      stopped_reason: "completed",
      next_run_at: null,
    });
  });

  it("skips without sending when another run claimed the step first", async () => {
    mocks.listDue.mockResolvedValue({ data: [sequence(0)], error: null });
    mocks.results.appointments = [{ data: appointmentRow(), error: null }];
    mocks.results.followup_sequences = [{ data: null, error: null }];
    const summary = await runInvoiceFollowups(now);
    expect(summary).toMatchObject({ skipped: 1, sent: 0 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("notifies clinic admins when every channel fails, deduped per appointment", async () => {
    mocks.listDue.mockResolvedValue({ data: [sequence(1)], error: null });
    mocks.results.appointments = [{ data: appointmentRow(), error: null }];
    mocks.results.followup_sequences = [{ data: { id: sequence().id }, error: null }];
    mocks.results.patients = [{ data: { id: patientId, full_name: "Sara", phone: null, email: null }, error: null }];
    mocks.send.mockResolvedValue({ ok: false, code: "NO_USABLE_CHANNEL" });
    const summary = await runInvoiceFollowups(now);
    expect(summary.failed).toBe(1);
    expect(mocks.emit.mock.calls[0][0]).toMatchObject({
      type: "followup_failed",
      roles: ["admin"],
      dedupeUnread: true,
      dedupeData: { appointmentId },
    });
  });
});

describe("ensureInvoiceFollowupSequence", () => {
  it("registers the appointment idempotently", async () => {
    mocks.results.followup_sequences = [{ data: null, error: null }];
    await ensureInvoiceFollowupSequence(clinicId, appointmentId);
    expect(mocks.upserts).toHaveLength(1);
    expect(mocks.upserts[0].payload).toMatchObject({
      clinic_id: clinicId,
      appointment_id: appointmentId,
      step: 0,
      status: "active",
    });
    expect(mocks.upserts[0].options).toMatchObject({
      onConflict: "appointment_id",
      ignoreDuplicates: true,
    });
  });
});
