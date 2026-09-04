import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";

const APPOINTMENT_ID = "00000000-0000-4000-8000-000000000020";
const PATIENT_ID = "00000000-0000-4000-8000-000000000021";
const DOCTOR_ID = "00000000-0000-4000-8000-000000000022";
const RECEIPT_ID = "00000000-0000-4000-8000-000000000023";

const mocks = vi.hoisted(() => ({
  appointmentRows: [] as unknown[],
  settings: {
    name: "Clinic Identity",
    locale: "en",
    timezone: "Europe/Istanbul",
    time_format: "24h",
    digits: "latin",
    invoice_followup_email_subject: "Clinic overdue subject",
    invoice_followup_email_body: "Clinic overdue body",
  },
  dispatch: vi.fn(),
  previewPending: vi.fn(),
  createPending: vi.fn(),
}));

function appointmentQuery() {
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "is", "gt"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.in = vi.fn((field: string) => field === "status"
    ? chain
    : Promise.resolve({ data: mocks.appointmentRows, error: null }));
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({ select: () => appointmentQuery() }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  getClinicReminderSettings: async () => ({ data: mocks.settings, error: null }),
  createClinicScopedAdminClient: () => ({
    from: () => ({
      select: () => {
        const chain: Record<string, unknown> = {};
        chain.eq = vi.fn(() => chain);
        // The template query now narrows by the candidate approval states.
        chain.in = vi.fn(() => chain);
        chain.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [{ id: "template-1" }], error: null }).then(resolve);
        return chain;
      },
    }),
  }),
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  getActiveWhatsAppProvider: async () => "meta",
}));
vi.mock("@/lib/messaging/automated-send", () => ({
  AUTOMATED_TEMPLATE_APPROVAL_STATES: ["approved", "submitted", "draft"],
  dispatchPatientMessage: mocks.dispatch,
  anyChannelFailed: (result: { email?: { status: string }; whatsapp?: { status: string } }) =>
    result.email?.status === "failed" || result.whatsapp?.status === "failed",
  anyChannelSent: (result: { email?: { status: string }; whatsapp?: { status: string } }) =>
    result.email?.status === "sent" || result.whatsapp?.status === "sent",
}));
vi.mock("@/lib/booking/pending-workflow", () => ({
  previewPendingBooking: mocks.previewPending,
  createPendingActionBooking: mocks.createPending,
}));

import { LEGACY_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/legacy-actions";

const USER: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "private.actor@example.com",
  fullName: "Private Actor Name",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

const context = {
  conversationId: "00000000-0000-4000-8000-000000000003",
  aiRequestId: "00000000-0000-4000-8000-000000000004",
  actionReceiptId: RECEIPT_ID,
  idempotencyKey: "ai-action:test",
  // P6-07 added the server-derived conversation defaults to the execution
  // context. These legacy actions read none of them; the empty values are the
  // "no context available" shape every action must already fail closed on.
  locale: "en" as const,
  activePatientId: null,
  activeAppointmentId: null,
};

function action(id: string) {
  const definition = LEGACY_ACTION_DEFINITIONS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Missing action ${id}`);
  return definition;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.appointmentRows = [];
  mocks.dispatch.mockResolvedValue({
    email: { status: "sent" },
    whatsapp: { status: "sent" },
  });
  mocks.previewPending.mockResolvedValue({
    patient_name: "Mona Patient",
    doctor_name: "Dr Samir",
    scheduled_at: "2026-08-20T09:00:00.000Z",
    scheduled_at_label: "August 20, 2026 · 12:00",
    duration_minutes: 30,
    status: "pending",
    patient_notification: "not_sent",
  });
  mocks.createPending.mockResolvedValue({
    ok: true,
    appointmentId: APPOINTMENT_ID,
    preview: { status: "pending", patient_notification: "not_sent" },
  });
});

describe("Phase 4 legacy-action equivalence", () => {
  it("preserves appointment reminder recipients, channels, copy, and dedupe identity", async () => {
    mocks.appointmentRows = [{
      id: APPOINTMENT_ID,
      scheduled_at: "2026-08-20T09:00:00.000Z",
      patients: { full_name: "Mona Patient", phone: "+905551112233", email: "mona@example.com" },
      profiles: { full_name: "Dr Samir" },
    }];
    const definition = action("appointments.send_reminders");
    const input = { appointments: [{ id: APPOINTMENT_ID }] };
    const preview = await definition.preview(USER, input);
    const executed = await definition.execute(USER, input, context);

    expect(preview).toMatchObject({
      title: "Send appointment reminders",
      audit: { targetTable: "appointments", targetRecordIds: [APPOINTMENT_ID] },
    });
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `appointment_reminder:${APPOINTMENT_ID}`,
      recipient: { phone: "+905551112233", email: "mona@example.com" },
      whatsappActive: true,
      templateValues: expect.objectContaining({
        patient_name: "Mona Patient",
        clinic_name: "Clinic Identity",
        doctor_name: "Dr Samir",
      }),
      relatedType: "appointment",
      relatedId: APPOINTMENT_ID,
    }));
    expect(executed.data).toMatchObject({ count: 1, partial_failure: false });
  });

  it("uses clinic identity—not the actor identity—for patient-facing invoice reminders", async () => {
    mocks.appointmentRows = [{
      id: APPOINTMENT_ID,
      outstanding_amount: 750,
      patients: { full_name: "Mona Patient", phone: "+905551112233", email: "mona@example.com" },
    }];
    const definition = action("invoices.send_reminders");
    const input = { invoices: [{ appointment_id: APPOINTMENT_ID }] };
    await definition.execute(USER, input, context);

    const sent = mocks.dispatch.mock.calls[0]?.[0];
    expect(sent).toMatchObject({
      dedupeKey: `invoice_followup:${APPOINTMENT_ID}:step0`,
      subject: "Clinic overdue subject",
      body: "Clinic overdue body",
      templateValues: {
        patient_name: "Mona Patient",
        clinic_name: "Clinic Identity",
        doctor_name: "Clinic Identity",
      },
      relatedType: "invoice",
      relatedId: APPOINTMENT_ID,
    });
    expect(Object.values(sent.templateValues)).not.toContain(USER.fullName);
  });

  it("reports a real mixed-channel failure as partial and a total failure as non-partial", async () => {
    mocks.appointmentRows = [{
      id: APPOINTMENT_ID,
      outstanding_amount: 750,
      patients: { full_name: "Mona Patient", phone: "+905551112233", email: "mona@example.com" },
    }];
    mocks.dispatch.mockResolvedValueOnce({
      email: { status: "sent" },
      whatsapp: { status: "failed" },
    });
    const definition = action("invoices.send_reminders");
    const input = { invoices: [{ appointment_id: APPOINTMENT_ID }] };
    const partial = await definition.execute(USER, input, context);
    expect(partial.data).toMatchObject({ partial_failure: true });

    mocks.dispatch.mockResolvedValueOnce({
      email: { status: "failed" },
      whatsapp: { status: "failed" },
    });
    const totalFailure = await definition.execute(USER, input, context);
    expect(totalFailure.data).toMatchObject({ partial_failure: false });
  });

  it("preserves pending-only/no-notification preview and receipt provenance", async () => {
    const definition = action("appointments.create_pending");
    const input = {
      patient_id: PATIENT_ID,
      doctor_id: DOCTOR_ID,
      scheduled_at: "2026-08-20T09:00:00.000Z",
      duration_minutes: 30,
    };
    const preview = await definition.preview(USER, input);
    const executed = await definition.execute(USER, input, context);
    expect(preview.changes).toEqual(expect.arrayContaining([
      { label: "Status", before: null, after: "pending" },
      { label: "Patient notification", before: null, after: "not_sent" },
    ]));
    expect(mocks.createPending).toHaveBeenCalledWith(expect.objectContaining({
      user: USER,
      booking: input,
      actionReceiptId: RECEIPT_ID,
    }));
    expect(executed.data).toMatchObject({ appointment_id: APPOINTMENT_ID });
  });

  it("keeps the 25-recipient caps discriminating for both bulk actions", () => {
    const ids = Array.from({ length: 26 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(action("appointments.send_reminders").inputSchema.safeParse({
      appointments: ids.slice(0, 25).map((id) => ({ id })),
    }).success).toBe(true);
    expect(action("appointments.send_reminders").inputSchema.safeParse({
      appointments: ids.map((id) => ({ id })),
    }).success).toBe(false);
    expect(action("invoices.send_reminders").inputSchema.safeParse({
      invoices: ids.slice(0, 25).map((appointment_id) => ({ appointment_id })),
    }).success).toBe(true);
    expect(action("invoices.send_reminders").inputSchema.safeParse({
      invoices: ids.map((appointment_id) => ({ appointment_id })),
    }).success).toBe(false);
  });
});
