import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  InvoiceDocument,
  type InvoiceCopy,
} from "@/components/documents/templates/invoice";
import { getInvoiceCopy } from "@/lib/documents/invoice-copy";
import type { InvoiceDocumentSnapshot } from "@/lib/documents/resolvers/invoice";

const copy: InvoiceCopy = {
  title: "Invoice",
  labels: { documentNumber: "Invoice number", issueDate: "Date issued", issueTime: "Time" },
  billTo: "Bill to",
  patientId: "Patient ID",
  status: "Status",
  statuses: { paid: "Paid", partially_paid: "Partially paid", unpaid: "Unpaid" },
  cards: { invoiceTotal: "Invoice total", insuranceCoverage: "Insurance coverage", amountDue: "Amount due" },
  columns: { service: "Service name", reference: "Ref", unitPrice: "Unit price", quantity: "Qty", total: "Total" },
  emptyLineItems: "No billed services",
  billingNotes: "Billing notes",
  summary: {
    subtotal: "Subtotal",
    insuranceShare: "Insurance share",
    paymentBreakdown: "Payment breakdown",
    totalPaid: "Total paid",
    outstandingBalance: "Outstanding balance",
  },
  paymentMethods: {
    cash: "Cash",
    credit_card: "Credit card",
    paypal: "PayPal",
    bank_transfer: "Bank transfer / other",
    insurance: "Insurance",
    other: "Other",
  },
  verificationTitle: "Record verification",
  verificationCaption: "Scan to verify",
  taxInvoiceNote: "Tax registration number:",
  authorizedSignature: "Authorized signature",
  patientSignature: "Patient signature",
  clinicStamp: "Clinic stamp",
  footerAttribution: "ClinicFlow",
  copyright: "ClinicFlow",
  page: "Page",
  of: "of",
};

const snapshot: InvoiceDocumentSnapshot = {
  version: 1,
  generatedAt: "2026-07-29T10:30:00.000Z",
  appointmentId: "22222222-2222-4222-8222-222222222222",
  branding: {
    name: "ClinicFlow Demo",
    logoSrc: null,
    address: "124 Medical Plaza",
    phone: "+90 555 000 0000",
    email: "clinic@example.com",
    website: "clinic.example.com",
    licenseNo: "MP-882-901",
    taxId: "TAX-99",
    footerText: null,
  },
  format: { currency: "TRY", timeZone: "Europe/Istanbul", timeFormat: "24h" },
  settings: {
    watermark: "OFFICIAL RECORD",
    qrEnabled: true,
    numberingPrefix: "INV",
    numberingYearlyReset: true,
    sequencePadding: 4,
  },
  patient: { fullName: "Mert Kaya", fileNumber: "PAT-88210", departmentName: "Dermatology" },
  appointment: {
    scheduledAt: "2026-07-29T09:00:00.000Z",
    paidAt: "2026-07-29T10:00:00.000Z",
    doctorName: "Dr. Ahmed",
  },
  status: "partially_paid",
  lineItems: [
    {
      id: "line-1",
      name: "Chemical Peeling",
      reference: "DR-CP-001",
      unitPrice: 2000,
      quantity: 2,
      lineTotal: 4000,
    },
    {
      id: "line-2",
      name: "Laser Hair Removal",
      reference: "DR-LH-004",
      unitPrice: 3800,
      quantity: 1,
      lineTotal: 3800,
    },
  ],
  totals: {
    subtotal: 7800,
    insuranceCoverage: 1700,
    amountDue: 6100,
    paidTotal: 1000,
    outstanding: 5100,
  },
  payments: [{ method: "cash", amount: 1000 }],
  billingNotes: "Remaining balance settled within 30 days as per patient request.",
};

describe("P7-7 Invoice document", () => {
  it("renders a draft with the approved primitive order and no official identity", () => {
    const { container } = render(
      <InvoiceDocument locale="en" lifecycle="preview" snapshot={snapshot} copy={copy} />,
    );
    const page = container.querySelector("[data-testid='document-page']");
    const bodyPrimitives = Array.from(container.querySelectorAll(".cf-document-body > * [data-testid], .cf-document-body > [data-testid]"))
      .map((node) => node.getAttribute("data-testid"))
      .filter((value): value is string => value !== null);

    expect(page).toHaveAttribute("dir", "ltr");
    expect(page).toHaveAttribute("data-lifecycle", "preview");
    // IdentityHero carries the StatusBadge; then totals, table, notes, field grid.
    expect(bodyPrimitives.slice(0, 2)).toEqual(["identity-hero", "status-badge"]);
    expect(bodyPrimitives).toContain("totals-summary");
    expect(bodyPrimitives).toContain("data-table");
    expect(bodyPrimitives).toContain("notes-callout");
    expect(bodyPrimitives).toContain("field-grid");
    expect(bodyPrimitives).toContain("signature-block");
    expect(container).toHaveTextContent("DRAFT");
    expect(container).not.toHaveTextContent("INV-2026-0001");
    expect(container.querySelector("[data-testid='verification-block']")).toBeNull();
  });

  it("renders fully localized Arabic system copy with Latin digits, canonical number, and QR", async () => {
    const arabicCopy = await getInvoiceCopy("ar");
    const { container } = render(
      <InvoiceDocument
        locale="ar"
        lifecycle="issued"
        snapshot={snapshot}
        copy={arabicCopy}
        documentNumber="INV-2026-0001"
        qrDataUrl="data:image/png;base64,iVBORw0KGgo="
      />,
    );

    expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "rtl");
    expect(container).toHaveTextContent("INV-2026-0001");
    expect(container).toHaveTextContent("Mert Kaya");
    expect(container).toHaveTextContent("Chemical Peeling");
    expect(container.querySelector(".cf-doc-title")).toHaveTextContent("الفاتورة");
    expect(container.querySelector(".cf-doc-meta-grid")).toHaveTextContent("رقم الفاتورة");
    expect(container).toHaveTextContent("مدفوعة جزئياً");
    expect(container.querySelector("[data-testid='totals-summary']"))
      .toHaveTextContent("إجمالي الفاتورة");
    expect(container.querySelector("[data-testid='data-table'] thead"))
      .toHaveTextContent("اسم الخدمة");
    expect(container.querySelector("[data-testid='status-badge']"))
      .toHaveAttribute("data-tone", "warning");
    expect(container.querySelector("[data-testid='verification-block'] img"))
      .toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo=");
    // Two signature slots: authorized + patient.
    expect(container.querySelectorAll("[data-testid='signature-block'] .cf-doc-signature-label"))
      .toHaveLength(2);
    expect(container.querySelector("[data-testid='signature-block'] .cf-doc-stamp-slot"))
      .toHaveTextContent("ختم العيادة");
    expect(container.querySelector("[data-testid='signature-block']"))
      .toHaveTextContent("توقيع المعتمد");
    expect(container.querySelector("[data-testid='verification-block']"))
      .toHaveTextContent("التحقق من السجل");
    for (const english of [
      "Invoice number",
      "Partially paid",
      "Invoice total",
      "Insurance coverage",
      "Amount due",
      "Billing notes",
      "Authorized signature",
      "Patient signature",
      "Clinic stamp",
      "Record verification",
    ]) {
      expect(container).not.toHaveTextContent(english);
    }
    expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
  });
});
