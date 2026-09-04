import "server-only";

import { z } from "zod";
import { DocumentSubjectNotFoundError } from "@/lib/documents/resolvers/errors";
import { getDocumentCatalogEntry } from "@/lib/documents/catalog";
import { inlineClinicLogo } from "@/lib/documents/assets";
import { createClient } from "@/lib/supabase/server";

/**
 * P7-7 Invoice resolver.
 *
 * The invoice is a financial document whose only source of truth is the
 * completed appointment's billing record and its persisted service line items.
 * No amounts, line items, or payment facts are ever accepted from a browser
 * payload — the resolver reads the tenant-scoped `appointments`,
 * `appointment_services`, patient, doctor, and department records through RLS
 * and freezes them into an immutable snapshot at issue time.
 */

export const invoiceDocumentParamsSchema = z.object({
  appointmentId: z.string().uuid(),
});

export type InvoiceDocumentParams = z.infer<typeof invoiceDocumentParamsSchema>;

export const INVOICE_PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "paypal",
  "bank_transfer",
  "insurance",
] as const;

const invoiceStatusSchema = z.enum(["paid", "partially_paid", "unpaid"]);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

const lineItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  reference: z.string().nullable(),
  unitPrice: z.number(),
  quantity: z.number(),
  lineTotal: z.number(),
});

const paymentBreakdownSchema = z.object({
  method: z.enum(INVOICE_PAYMENT_METHODS),
  amount: z.number(),
});

export const invoiceDocumentSnapshotSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  appointmentId: z.string().uuid(),
  branding: z.object({
    name: z.string(),
    logoSrc: z.string().nullable(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    website: z.string().nullable(),
    licenseNo: z.string().nullable(),
    taxId: z.string().nullable(),
    footerText: z.string().nullable(),
  }),
  format: z.object({
    currency: z.string(),
    timeZone: z.string(),
    timeFormat: z.enum(["12h", "24h"]),
  }),
  settings: z.object({
    watermark: z.string().nullable(),
    qrEnabled: z.boolean(),
    numberingPrefix: z.string(),
    numberingYearlyReset: z.boolean(),
    sequencePadding: z.number().int().min(1).max(12),
  }),
  patient: z.object({
    fullName: z.string(),
    fileNumber: z.string().nullable(),
    departmentName: z.string().nullable(),
  }),
  appointment: z.object({
    scheduledAt: z.string(),
    paidAt: z.string().nullable(),
    doctorName: z.string(),
  }),
  status: invoiceStatusSchema,
  lineItems: z.array(lineItemSchema),
  totals: z.object({
    subtotal: z.number(),
    insuranceCoverage: z.number(),
    amountDue: z.number(),
    paidTotal: z.number(),
    outstanding: z.number(),
  }),
  payments: z.array(paymentBreakdownSchema),
  billingNotes: z.string().nullable(),
});

export type InvoiceDocumentSnapshot = z.infer<typeof invoiceDocumentSnapshotSchema>;

type RelationName = { full_name?: string | null; name?: string | null } | null;

function relationText(relation: RelationName, key: "full_name" | "name"): string {
  return relation?.[key]?.trim() || "—";
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function resolveInvoiceStatus(paidTotal: number, outstanding: number): InvoiceStatus {
  if (outstanding <= 0.001) return "paid";
  if (paidTotal > 0.001) return "partially_paid";
  return "unpaid";
}

type AppointmentBillingRow = {
  id: string;
  patient_id: string;
  doctor_id: string;
  department_id: string | null;
  scheduled_at: string;
  paid_at: string | null;
  status: string;
  total_amount: number | null;
  paid_amount: number | null;
  secondary_amount: number | null;
  insurance_amount: number | null;
  deposit_amount: number | null;
  outstanding_amount: number | null;
  patient_responsibility: number | null;
  payment_method: string | null;
  secondary_payment_method: string | null;
  payment_note: string | null;
  patient: RelationName;
  doctor: RelationName;
  department: RelationName;
};

/** Merge payment method amounts into a stable, de-duplicated breakdown. */
function buildPaymentBreakdown(
  row: AppointmentBillingRow,
): InvoiceDocumentSnapshot["payments"] {
  const totals = new Map<(typeof INVOICE_PAYMENT_METHODS)[number], number>();
  const add = (method: string | null, amount: number) => {
    if (amount <= 0.001) return;
    const normalized = (INVOICE_PAYMENT_METHODS as readonly string[]).includes(method ?? "")
      ? (method as (typeof INVOICE_PAYMENT_METHODS)[number])
      : "cash";
    totals.set(normalized, round2((totals.get(normalized) ?? 0) + amount));
  };
  add(row.payment_method, Number(row.paid_amount ?? 0));
  add(row.secondary_payment_method, Number(row.secondary_amount ?? 0));
  // A deposit is a real prior patient payment; attribute it to its own method
  // slot only when one was recorded, otherwise fold it into cash.
  add(row.payment_method ?? "cash", Number(row.deposit_amount ?? 0));
  return INVOICE_PAYMENT_METHODS.filter((method) => totals.has(method)).map((method) => ({
    method,
    amount: totals.get(method) ?? 0,
  }));
}

export async function resolveInvoiceDocumentSnapshot(
  clinicId: string,
  rawParams: InvoiceDocumentParams,
): Promise<InvoiceDocumentSnapshot> {
  const params = invoiceDocumentParamsSchema.parse(rawParams);
  const supabase = await createClient();

  const appointmentResult = await supabase
    .from("appointments")
    .select(`
      id, patient_id, doctor_id, department_id, scheduled_at, paid_at, status,
      total_amount, paid_amount, secondary_amount, insurance_amount, deposit_amount,
      outstanding_amount, patient_responsibility, payment_method, secondary_payment_method,
      payment_note,
      patient:patients!appointments_patient_id_fkey(full_name, file_number),
      doctor:profiles!appointments_doctor_id_fkey(full_name),
      department:departments!appointments_department_id_fkey(name)
    `)
    .eq("clinic_id", clinicId)
    .eq("id", params.appointmentId)
    .is("deleted_at", null)
    .maybeSingle();

  if (appointmentResult.error) throw new Error(appointmentResult.error.message);
  if (!appointmentResult.data) throw new DocumentSubjectNotFoundError("appointment");
  const appointment = appointmentResult.data as unknown as AppointmentBillingRow & {
    patient: { full_name?: string | null; file_number?: string | null } | null;
  };
  if (appointment.status !== "completed") {
    throw new Error("Invoices are only available for completed appointments");
  }

  const [servicesResult, clinicResult, settingsResult] = await Promise.all([
    supabase
      .from("appointment_services")
      .select("id, name, price, quantity, service_id")
      .eq("clinic_id", clinicId)
      .eq("appointment_id", params.appointmentId)
      .order("created_at", { ascending: true }),
    supabase
      .from("clinics")
      .select(
        "name, logo_url, address, phone, email, website, license_no, tax_id, document_footer, currency, timezone, time_format",
      )
      .eq("id", clinicId)
      .single(),
    supabase
      .from("document_settings")
      .select(
        "doc_type, watermark_enabled, watermark_text, qr_enabled, numbering_prefix, numbering_yearly_reset",
      )
      .eq("clinic_id", clinicId)
      .or("doc_type.is.null,doc_type.eq.INVOICE"),
  ]);

  if (servicesResult.error) throw new Error(servicesResult.error.message);
  if (clinicResult.error || !clinicResult.data) {
    throw new Error(clinicResult.error?.message ?? "Clinic branding was not found");
  }
  if (settingsResult.error) throw new Error(settingsResult.error.message);

  const clinic = clinicResult.data;
  const settingRows = settingsResult.data ?? [];
  const typeSettings = settingRows.find((row) => row.doc_type === "INVOICE");
  const globalSettings = settingRows.find((row) => row.doc_type === null);
  const effectiveSettings = typeSettings ?? globalSettings;
  const catalog = getDocumentCatalogEntry("INVOICE");
  const watermarkEnabled = effectiveSettings?.watermark_enabled ?? true;
  const watermark = watermarkEnabled
    ? effectiveSettings?.watermark_text?.trim() || clinic.name
    : null;
  // Always inlined: the canonical PDF renderer blocks remote requests, so a
  // snapshot holding an `https:` logo URL prints with no logo at all.
  const logoSrc = await inlineClinicLogo(clinic.logo_url, clinicId);

  const lineItems = (servicesResult.data ?? []).map((row) => {
    const unitPrice = round2(Number(row.price ?? 0));
    const quantity = Number(row.quantity ?? 1);
    return {
      id: row.id,
      name: row.name?.trim() || "—",
      reference: row.service_id ?? null,
      unitPrice,
      quantity,
      lineTotal: round2(unitPrice * quantity),
    };
  });

  const totalAmount = round2(Number(appointment.total_amount ?? 0));
  const insuranceCoverage = round2(Number(appointment.insurance_amount ?? 0));
  const lineItemSubtotal = round2(
    lineItems.reduce((sum, item) => sum + item.lineTotal, 0),
  );
  const subtotal = lineItems.length > 0 ? lineItemSubtotal : totalAmount;
  const amountDue = round2(
    appointment.patient_responsibility != null
      ? Number(appointment.patient_responsibility)
      : totalAmount - insuranceCoverage,
  );
  const payments = buildPaymentBreakdown(appointment);
  const paidTotal = round2(payments.reduce((sum, entry) => sum + entry.amount, 0));
  const outstanding = round2(
    appointment.outstanding_amount != null
      ? Number(appointment.outstanding_amount)
      : amountDue - paidTotal,
  );

  return invoiceDocumentSnapshotSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    appointmentId: appointment.id,
    branding: {
      name: clinic.name,
      logoSrc,
      address: clinic.address,
      phone: clinic.phone,
      email: clinic.email,
      website: clinic.website,
      licenseNo: clinic.license_no,
      taxId: clinic.tax_id,
      footerText: clinic.document_footer,
    },
    format: {
      currency: clinic.currency,
      timeZone: clinic.timezone,
      timeFormat: clinic.time_format === "12h" ? "12h" : "24h",
    },
    settings: {
      watermark,
      qrEnabled: effectiveSettings?.qr_enabled ?? true,
      numberingPrefix:
        typeSettings?.numbering_prefix?.trim()
        || globalSettings?.numbering_prefix?.trim()
        || catalog.numbering.prefix,
      numberingYearlyReset:
        effectiveSettings?.numbering_yearly_reset ?? catalog.numbering.yearlyReset,
      sequencePadding: catalog.numbering.sequencePadding,
    },
    patient: {
      fullName: appointment.patient?.full_name?.trim() || "—",
      fileNumber: appointment.patient?.file_number?.trim() || null,
      departmentName: appointment.department?.name?.trim() || null,
    },
    appointment: {
      scheduledAt: appointment.scheduled_at,
      paidAt: appointment.paid_at,
      doctorName: relationText(appointment.doctor, "full_name"),
    },
    status: resolveInvoiceStatus(paidTotal, outstanding),
    lineItems,
    totals: {
      subtotal,
      insuranceCoverage,
      amountDue,
      paidTotal,
      outstanding,
    },
    payments,
    billingNotes: appointment.payment_note?.trim() || null,
  });
}

export function parseInvoiceDocumentSnapshot(value: unknown): InvoiceDocumentSnapshot {
  return invoiceDocumentSnapshotSchema.parse(value);
}
