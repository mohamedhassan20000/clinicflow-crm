import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentConformanceHarness } from "@/components/documents/harness/document-conformance-harness";
import {
  P72_CONFORMANCE_MANIFEST,
  P72_FIGMA_FILE_KEY,
  P72_FROZEN_PRIMITIVES,
  getP72ConformanceSummary,
  isP72DocumentConformant,
} from "@/components/documents/harness/p72-conformance-manifest";
import { DOCUMENT_TYPE_CODES } from "@/lib/documents/catalog";

const QR_DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

describe("P7-2 design-to-engine conformance gate", () => {
  it("covers the 16 imported Figma designs with paired Arabic and English evidence", () => {
    // The P7-2 design→engine gate is defined over the 16 imported Figma designs.
    // The 4 P7-12 history/financial types are engine-composed from the frozen
    // primitive set (no new free-form Figma design), so they are intentionally
    // outside this design-conformance gate — the manifest still equals exactly
    // the first 16 catalog codes, in order.
    expect(P72_CONFORMANCE_MANIFEST.map((entry) => entry.code)).toEqual(
      DOCUMENT_TYPE_CODES.slice(0, 16),
    );
    expect(P72_CONFORMANCE_MANIFEST).toHaveLength(16);
    expect(P72_FIGMA_FILE_KEY).toBe("nUzeFkN6Yn7m7knTzwmDHq");

    for (const entry of P72_CONFORMANCE_MANIFEST) {
      expect(entry.variants.map((variant) => variant.locale)).toEqual(["ar", "en"]);
      expect(entry.variants).toHaveLength(2);
      expect(entry.cleanup.length).toBeGreaterThanOrEqual(3);
      expect(entry.variants.every((variant) => variant.status === "verified_from_figma")).toBe(true);
      expect(entry.variants.every((variant) => variant.figmaNodeId !== null)).toBe(true);
    }
  });

  it("maps every body region to the frozen P7-1 primitive set without additions", () => {
    const frozen = new Set<string>(P72_FROZEN_PRIMITIVES);

    for (const entry of P72_CONFORMANCE_MANIFEST) {
      expect(entry.primitives.length).toBeGreaterThan(0);
      expect(entry.primitives.every((primitive) => frozen.has(primitive))).toBe(true);
      expect(entry.uncoveredRegions).toEqual([]);
      expect(entry.requiresNewPrimitive).toBe(false);
      expect(entry.primitives).not.toContain("DocumentHeader");
      expect(entry.primitives).not.toContain("DocumentFooter");
    }
  });

  it("passes after the approved Prescription A4 cleanup resolves the final conflict", () => {
    const summary = getP72ConformanceSummary();

    expect(summary).toEqual({
      documents: 16,
      variants: 32,
      verifiedVariants: 32,
      missingReferenceVariants: 0,
      quotaBlockedVariants: 0,
      engineConflictDocuments: 0,
      conformantDocuments: 16,
      gatePassed: true,
    });
    expect(P72_CONFORMANCE_MANIFEST.filter(isP72DocumentConformant).map((entry) => entry.ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
    const prescription = P72_CONFORMANCE_MANIFEST.find((entry) => entry.ordinal === 5);
    expect(prescription?.engineConflicts).toEqual([]);
    expect(prescription?.cleanup).toContainEqual(expect.stringContaining("shared A4 portrait geometry"));
    expect(prescription?.variants[1].figmaNodeId).toBe("12:521");
  });

  it("pins the corrected Revenue Report locale-to-node mapping", () => {
    const revenueReport = P72_CONFORMANCE_MANIFEST.find((entry) => entry.ordinal === 1);
    expect(revenueReport?.variants).toMatchObject([
      { locale: "ar", figmaNodeId: "8:262" },
      { locale: "en", figmaNodeId: "8:18" },
    ]);
  });

  it("renders every mapped design in LTR and RTL with Latin digits and inlined QR data", () => {
    for (const entry of P72_CONFORMANCE_MANIFEST) {
      for (const locale of ["en", "ar"] as const) {
        const { container, unmount } = render(
          <DocumentConformanceHarness entry={entry} locale={locale} qrDataUrl={QR_DATA_URL} />,
        );
        const page = container.querySelector<HTMLElement>("[data-testid='document-page']");
        const mapped = Array.from(container.querySelectorAll<HTMLElement>("[data-p72-primitive]"))
          .map((node) => node.dataset.p72Primitive);

        expect(page).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
        expect(page).toHaveAttribute("data-digits", "latn");
        expect(page).toHaveAttribute("data-orientation", "portrait");
        expect(mapped).toEqual(entry.primitives);
        expect(container.textContent).not.toMatch(/[٠-٩۰-۹]/);
        for (const image of container.querySelectorAll("img")) {
          expect(image.getAttribute("src")).toMatch(/^data:image\//);
        }
        unmount();
      }
    }
  });
});
