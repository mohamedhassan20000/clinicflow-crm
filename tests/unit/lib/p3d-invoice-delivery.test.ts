import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  send: vi.fn(),
  waActive: vi.fn(),
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
  dispatchPatientMessage: mocks.send,
}));
vi.mock("@/lib/messaging/channel-management", () => ({
  hasActiveWhatsAppChannel: mocks.waActive,
}));

import {
  buildInvoiceSummary,
  renderInvoiceMessage,
  deliverIssuedInvoice,
  type InvoiceSummary,
} from "@/lib/messaging/invoice-delivery";

const clinicId = "11111111-1111-4111-8111-111111111111";
const appointmentId = "22222222-2222-4222-8222-222222222222";
const patientId = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  mocks.tables.appointments = {
    data: {
      id: appointmentId,
      patient_id: patientId,
      total_amount: 45,
      outstanding_amount: 15,
    },
    error: null,
  };
  mocks.tables.patients = {
    data: { id: patientId, full_name: "Sara", phone: "+96550000001", email: "sara@example.com" },
    error: null,
  };
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
  mocks.waActive.mockResolvedValue(true);
  mocks.send.mockResolvedValue({
    email: { status: "sent" },
    whatsapp: { status: "sent" },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

const baseSummary: InvoiceSummary = {
  clinicId,
  appointmentId,
  patient: { full_name: "Sara", phone: "+96550000001", email: "sara@example.com" },
  clinicName: "Clinic A",
  locale: "en",
  currency: "KWD",
  clinicLocaleTag: "en",
  digits: "latin",
  total: 45,
  outstanding: 15,
};

describe("renderInvoiceMessage (template-agnostic render stage)", () => {
  it("states amounts and the outstanding balance when unpaid", () => {
    const rendered = renderInvoiceMessage(baseSummary);
    expect(rendered.subject).toContain("Clinic A");
    expect(rendered.body).toMatch(/Invoice total/i);
    expect(rendered.body).toMatch(/Outstanding balance/i);
    expect(rendered.templateValues.invoice_total).toBe(rendered.templateValues.invoice_total);
    expect(rendered.templateValues.patient_name).toBe("Sara");
  });

  it("says paid in full when nothing is outstanding", () => {
    const rendered = renderInvoiceMessage({ ...baseSummary, outstanding: 0 });
    expect(rendered.body).toMatch(/Paid in full/i);
  });
});

describe("buildInvoiceSummary (compose stage)", () => {
  it("reads the existing appointment billing representation", async () => {
    const composed = await buildInvoiceSummary(clinicId, appointmentId);
    expect(composed?.summary).toMatchObject({
      clinicId,
      appointmentId,
      total: 45,
      outstanding: 15,
      currency: "KWD",
      locale: "en",
    });
  });

  it("returns null when the patient row is missing", async () => {
    mocks.tables.patients = { data: null, error: null };
    expect(await buildInvoiceSummary(clinicId, appointmentId)).toBeNull();
  });
});

describe("deliverIssuedInvoice (send stage)", () => {
  it("sends immediately via the messaging boundary as an invoice", async () => {
    await deliverIssuedInvoice({ clinicId, appointmentId });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      clinicId,
      dedupeKey: `invoice:${appointmentId}`,
      relatedType: "invoice",
      relatedId: appointmentId,
      locale: "en",
      whatsappActive: true,
    });
  });

  it("is best-effort — never throws and does not send when the appointment is missing", async () => {
    mocks.tables.appointments = { data: null, error: null };
    await expect(deliverIssuedInvoice({ clinicId, appointmentId })).resolves.toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
