import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_CATALOG } from "@/lib/documents/catalog";
import {
  P74_ANALYTICAL_DOCUMENT_CODES,
  analyticalDocumentParamsSchema,
  analyticalDocumentSnapshotSchema,
} from "@/lib/documents/resolvers/analytical-report";

describe("P7-4 analytical document contract", () => {
  it("registers exactly the approved seven-document batch with frozen prefixes", () => {
    expect(P74_ANALYTICAL_DOCUMENT_CODES).toEqual([
      "FOLLOW_UP_PAGE_REPORT",
      "CANCELLATION_REPORT",
      "NO_SHOW_REPORT",
      "SALES_REPORT",
      "FOLLOW_UP_ANALYTICS_REPORT",
      "DOCTOR_PERFORMANCE_REPORT",
      "RECEPTIONIST_PERFORMANCE_REPORT",
    ]);
    expect(P74_ANALYTICAL_DOCUMENT_CODES.map((code) => DOCUMENT_CATALOG[code].numbering.prefix))
      .toEqual(["FU", "CR", "NS", "SAL", "FUA", "DPF", "RPF"]);
    expect(DOCUMENT_CATALOG.SALES_REPORT.resolver).toEqual({
      kind: "document",
      resolverId: "sales-report",
    });
    expect(DOCUMENT_CATALOG.FOLLOW_UP_ANALYTICS_REPORT.resolver).toEqual({
      kind: "document",
      resolverId: "follow-up-analytics-report",
    });
  });

  it("accepts bounded typed inputs and keeps snapshots at version one", () => {
    expect(analyticalDocumentParamsSchema.safeParse({
      documentType: "SALES_REPORT",
      from: "2026-07-01",
      to: "2026-07-31",
    }).success).toBe(true);
    expect(analyticalDocumentParamsSchema.safeParse({
      documentType: "PATIENT_LIST_REPORT",
      from: "2026-07-01",
      to: "2026-07-31",
    }).success).toBe(false);
    expect(analyticalDocumentParamsSchema.safeParse({
      documentType: "SALES_REPORT",
      from: "2026-08-01",
      to: "2026-07-31",
    }).success).toBe(false);
    expect(analyticalDocumentSnapshotSchema.shape.version.value).toBe(1);
  });

  it("routes the whole batch through the existing idempotent foundation", () => {
    const actions = readFileSync(join(process.cwd(), "actions/documents.ts"), "utf8");
    const core = readFileSync(join(process.cwd(), "lib/documents/mutations.ts"), "utf8");
    expect(actions).toContain("issueAnalyticalReportDocument");
    expect(actions).toContain("issueAnalyticalDocumentCore(user, {");
    expect(core).toContain("issueDocumentFoundation({");
    expect(core).toContain("render: getDocumentPdfRenderer(code)");
    expect(actions).toContain("record_analytical_document_reprint");
    expect(actions).not.toContain("allocate_document_number");
    expect(core).not.toContain("allocate_document_number");
  });
});
