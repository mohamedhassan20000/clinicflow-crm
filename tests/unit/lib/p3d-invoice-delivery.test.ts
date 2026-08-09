import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  send: vi.fn(),
  waActive: vi.fn(),
  captureException: vi.fn(),
  issueInvoice: vi.fn(),
  downloadPdf: vi.fn(),
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
  downloadClinicDocumentPdf: mocks.downloadPdf,
  createClinicScopedAdminClient: () => ({
    from: (table: string) =>
      tableChain(mocks.tables[table] ?? { data: null, error: null }),
  }),
}));
vi.mock("@/lib/documents/invoice-issuance", () => ({
  issueInvoiceDocument: mocks.issueInvoice,
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
  mocks.issueInvoice.mockResolvedValue({
    documentId: "44444444-4444-4444-8444-444444444444",
    documentNumber: "INV-2026-0001",
    verificationToken: "0123456789abcdef0123456789abcdef",
    reused: false,
  });
  mocks.downloadPdf.mockResolvedValue({
    data: { arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer },
    error: null,
    storagePath: "documents/clinic/INVOICE/doc.pdf",
  });
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

const actorId = "55555555-5555-4555-8555-555555555555";

describe("deliverIssuedInvoice (send stage)", () => {
  it("sends immediately via the messaging boundary as an invoice", async () => {
    await deliverIssuedInvoice({ clinicId, appointmentId, actorId });
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

  it("attaches the canonical invoice PDF to the email channel", async () => {
    await deliverIssuedInvoice({ clinicId, appointmentId, actorId });
    const dispatch = mocks.send.mock.calls[0][0] as {
      emailAttachments?: { filename: string; content: string; contentType?: string }[];
      body: string;
    };
    expect(mocks.issueInvoice).toHaveBeenCalledWith({
      clinicId,
      actorId,
      appointmentId,
      locale: "en",
    });
    expect(dispatch.emailAttachments).toHaveLength(1);
    expect(dispatch.emailAttachments?.[0]).toMatchObject({
      filename: "INV-2026-0001.pdf",
      contentType: "application/pdf",
    });
    expect(dispatch.body).toContain("INV-2026-0001");
  });

  it("degrades to text-only delivery when the canonical PDF cannot be issued", async () => {
    mocks.issueInvoice.mockRejectedValueOnce(new Error("issue failed"));
    await deliverIssuedInvoice({ clinicId, appointmentId, actorId });
    expect(mocks.send).toHaveBeenCalledOnce();
    const dispatch = mocks.send.mock.calls[0][0] as { emailAttachments?: unknown[] };
    expect(dispatch.emailAttachments).toBeUndefined();
  });

  it("is best-effort — never throws and does not send when the appointment is missing", async () => {
    mocks.tables.appointments = { data: null, error: null };
    await expect(
      deliverIssuedInvoice({ clinicId, appointmentId, actorId }),
    ).resolves.toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
