import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  revenueDocumentParamsSchema,
  revenueDocumentSnapshotSchema,
} from "@/lib/documents/resolvers/revenue-report";

describe("P7-3 Revenue Report vertical-slice contract", () => {
  it("accepts a bounded report range and rejects reversed dates", () => {
    expect(revenueDocumentParamsSchema.safeParse({ from: "2026-07-01", to: "2026-07-31" }).success)
      .toBe(true);
    expect(revenueDocumentParamsSchema.safeParse({ from: "2026-08-01", to: "2026-07-31" }).success)
      .toBe(false);
  });

  it("freezes the issued snapshot at version one", () => {
    expect(revenueDocumentSnapshotSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(revenueDocumentSnapshotSchema.shape.version.value).toBe(1);
  });

  it("routes issuance through the existing idempotent P7-0 foundation", () => {
    // Phase 6 moved the issuance body into the shared session-free core so the
    // Assistant issues through identical code; the server action is an adapter.
    const source = readFileSync(join(process.cwd(), "lib/documents/mutations.ts"), "utf8");
    const action = readFileSync(join(process.cwd(), "actions/documents.ts"), "utf8");
    expect(action).toContain("issueRevenueDocumentCore(user, {");
    expect(source).toContain("issueDocumentFoundation({");
    expect(source).toContain("idempotencyKey: `revenue:${input.idempotencyKey}`");
    expect(source).toContain("render: getDocumentPdfRenderer(catalog.code)");
    const renderer = readFileSync(
      join(process.cwd(), "lib/documents/renderers/revenue-report.tsx"),
      "utf8",
    );
    expect(renderer).toContain("renderDocument: (renderContextBoundary)");
    expect(renderer).toContain("renderContextBoundary={renderContextBoundary}");
    expect(renderer).not.toContain("StaticDocumentRenderBoundary");
    expect(source).toContain("snapshot: snapshot as unknown as Json");
    expect(source).not.toContain("allocate_document_number");
    expect(action).not.toContain("allocate_document_number");
  });
});
