import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  invoiceDocumentParamsSchema,
  invoiceDocumentSnapshotSchema,
} from "@/lib/documents/resolvers/invoice";
import { DOCUMENT_CATALOG } from "@/lib/documents/catalog";

describe("P7-7 Invoice document contract", () => {
  it("accepts an appointment id and rejects a non-uuid", () => {
    expect(
      invoiceDocumentParamsSchema.safeParse({
        appointmentId: "22222222-2222-4222-8222-222222222222",
      }).success,
    ).toBe(true);
    expect(invoiceDocumentParamsSchema.safeParse({ appointmentId: "nope" }).success).toBe(false);
  });

  it("freezes the issued snapshot at version one", () => {
    expect(invoiceDocumentSnapshotSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(invoiceDocumentSnapshotSchema.shape.version.value).toBe(1);
  });

  it("registers INVOICE as the financial archetype with the INV prefix", () => {
    expect(DOCUMENT_CATALOG.INVOICE.archetype).toBe("financial");
    expect(DOCUMENT_CATALOG.INVOICE.numbering.prefix).toBe("INV");
    expect(DOCUMENT_CATALOG.INVOICE.template).toBe("InvoiceTemplate");
    expect(DOCUMENT_CATALOG.INVOICE.subject).toBe("appointment");
  });

  it("issues through the shared idempotent foundation with one canonical document per appointment", () => {
    const source = readFileSync(join(process.cwd(), "lib/documents/invoice-issuance.ts"), "utf8");
    expect(source).toContain("issueDocumentFoundation({");
    expect(source).toContain("const idempotencyKey = `invoice:${input.appointmentId}`");
    expect(source).toContain("idempotencyKey,");
    expect(source).toContain("render = getDocumentPdfRenderer(catalog.code)");
    expect(source).toContain("render,");
    expect(source).toContain("findCompletedClinicDocument({");
    expect(source).toContain("snapshot: snapshot as unknown as Json");
    expect(source).not.toContain("allocate_document_number");
  });

  it("delivers through the existing seam without a parallel delivery system", () => {
    const source = readFileSync(join(process.cwd(), "lib/messaging/invoice-delivery.ts"), "utf8");
    // Reuses the shared dispatch + per-channel idempotency ledger.
    expect(source).toContain("dispatchPatientMessage(");
    expect(source).toContain("dedupeKey: `invoice:${input.appointmentId}`");
    // Attaches the canonical PDF to the email channel only.
    expect(source).toContain("emailAttachments");
    expect(source).toContain("downloadClinicDocumentPdf");
    expect(source).not.toContain("claim_message_dispatch");
  });

  it("authors from completed server-owned billing records and opens issued links without appointment params", () => {
    const authoring = readFileSync(join(process.cwd(), "lib/documents/manual-authoring.ts"), "utf8");
    const page = readFileSync(join(process.cwd(),
      "app/(protected)/appointments/invoice/document/page.tsx"), "utf8");
    expect(authoring).toContain('.eq("status", "completed")');
    expect(authoring).toContain('.from("appointment_services")');
    expect(page.indexOf("if (sp.documentId)")).toBeLessThan(page.indexOf("if (!appointmentId) notFound()"));
  });

  it("logs structured invoice issue stages and Postgres fields", () => {
    const core = readFileSync(join(process.cwd(), "lib/documents/mutations.ts"), "utf8");
    expect(core).toContain("describeDocumentIssueFailure(error, \"invoice-action\")");
    expect(core).toContain('console.error("invoice_document_issue_failed"');
    expect(core).toContain("...failure");
  });
});
