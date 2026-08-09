import { render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { GenericDocument } from "@/components/documents/templates/generic-document";
import {
  MAX_GENERIC_BLOCKS,
  genericDocumentParamsSchema,
  parseGenericBody,
} from "@/lib/documents/resolvers/generic-document";
import { getGenericDocumentCopy } from "@/lib/documents/generic-copy";
import type { GenericDocumentSnapshot } from "@/lib/documents/generic-shared";

describe("P7 Phase 4 — generic free-form document authoring", () => {
  it("parses a plain body into headings + paragraphs without raw HTML", () => {
    const blocks = parseGenericBody(
      "# Summary\nFirst line\nstill first paragraph\n\nSecond paragraph\n## Notes\nA note.",
    );
    expect(blocks).toEqual([
      { kind: "heading", text: "Summary" },
      { kind: "paragraph", text: "First line still first paragraph" },
      { kind: "paragraph", text: "Second paragraph" },
      { kind: "heading", text: "Notes" },
      { kind: "paragraph", text: "A note." },
    ]);
  });

  it("ignores blank input and caps the number of blocks", () => {
    expect(parseGenericBody("   \n\n  ")).toEqual([]);
    const many = Array.from({ length: MAX_GENERIC_BLOCKS + 20 }, (_, i) => `Para ${i}`).join("\n\n");
    expect(parseGenericBody(many).length).toBe(MAX_GENERIC_BLOCKS);
  });

  it("does not treat a mid-line hash as a heading marker", () => {
    const blocks = parseGenericBody("Room #4 is ready");
    expect(blocks).toEqual([{ kind: "paragraph", text: "Room #4 is ready" }]);
  });

  it("requires a non-empty title and at least one block", () => {
    const ok = genericDocumentParamsSchema.safeParse({
      documentType: "GENERIC_DOCUMENT", title: "Clearance",
      blocks: [{ kind: "paragraph", text: "Body." }],
    });
    expect(ok.success).toBe(true);

    expect(genericDocumentParamsSchema.safeParse({
      documentType: "GENERIC_DOCUMENT", title: "  ", blocks: [{ kind: "paragraph", text: "x" }],
    }).success).toBe(false);

    expect(genericDocumentParamsSchema.safeParse({
      documentType: "GENERIC_DOCUMENT", title: "T", blocks: [],
    }).success).toBe(false);

    expect(genericDocumentParamsSchema.safeParse({
      documentType: "INVOICE", title: "T", blocks: [{ kind: "paragraph", text: "x" }],
    }).success).toBe(false);
  });

  it("localizes the frame copy (title/signature/footer) for AR and EN", () => {
    const en = getGenericDocumentCopy("en");
    const ar = getGenericDocumentCopy("ar");
    expect(en.authorizedSignature).toBe("Authorized signature");
    expect(ar.authorizedSignature).toBe("التوقيع المعتمد");
    expect(en.title).not.toBe(ar.title);
    expect(ar.stamp).toBe("ختم العيادة");
  });

  it("renders Arabic shared chrome while preserving user-authored free text", () => {
    const snapshot: GenericDocumentSnapshot = {
      version: 1,
      documentType: "GENERIC_DOCUMENT",
      generatedAt: "2026-08-08T10:30:00.000Z",
      title: "Patient instructions",
      blocks: [{ kind: "paragraph", text: "User-authored content stays as entered." }],
      branding: {
        name: "Clinic name",
        logoSrc: null,
        address: null,
        phone: null,
        email: null,
        website: null,
        licenseNo: null,
        taxId: null,
        footerText: null,
      },
      format: { timeZone: "Europe/Istanbul", timeFormat: "24h" },
      settings: {
        watermark: null,
        qrEnabled: true,
        numberingPrefix: "DOC",
        numberingYearlyReset: true,
        sequencePadding: 4,
      },
    };
    const { container } = render(createElement(GenericDocument, {
      locale: "ar",
      lifecycle: "issued",
      snapshot,
      copy: getGenericDocumentCopy("ar"),
      documentNumber: "DOC-2026-0001",
      qrDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    }));

    expect(container.querySelector("[data-testid='document-page']")).toHaveAttribute("dir", "rtl");
    expect(container.querySelector(".cf-doc-meta-grid")).toHaveTextContent("رقم المستند");
    expect(container.querySelector("[data-testid='signature-block']"))
      .toHaveTextContent("التوقيع المعتمد");
    expect(container.querySelector(".cf-doc-stamp-slot")).toHaveTextContent("ختم العيادة");
    expect(container.querySelector("[data-testid='verification-block']"))
      .toHaveTextContent("التحقق");
    expect(container.querySelector("[data-testid='document-footer']"))
      .toHaveTextContent("نظام مستندات كلينيك فلو");
    expect(container).toHaveTextContent("Patient instructions");
    expect(container).toHaveTextContent("User-authored content stays as entered.");
    for (const english of [
      "Document no.",
      "Authorized signature",
      "Recipient signature",
      "Clinic stamp",
      "Verification",
      "ClinicFlow Document System",
    ]) {
      expect(container).not.toHaveTextContent(english);
    }
    expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
  });
});
