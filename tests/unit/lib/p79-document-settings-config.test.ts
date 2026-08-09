import { describe, expect, it } from "vitest";
import { DOCUMENT_CATALOG } from "@/lib/documents/catalog";
import {
  configurableDocumentTypeCodes,
  resolveEffectiveDocumentSettings,
  type StoredDocumentSettings,
} from "@/lib/documents/settings-config";
import {
  documentSettingsInputSchema,
  documentSettingsResetSchema,
} from "@/lib/validations/documents-settings";

function stored(partial: Partial<StoredDocumentSettings>): StoredDocumentSettings {
  return {
    docType: null,
    watermarkEnabled: true,
    watermarkText: null,
    qrEnabled: true,
    numberingPrefix: null,
    numberingYearlyReset: true,
    printOptions: {},
    ...partial,
  };
}

describe("P7-9 settings-config resolution", () => {
  it("exposes every registered catalog type, in catalog order", () => {
    expect(configurableDocumentTypeCodes()).toEqual(Object.keys(DOCUMENT_CATALOG));
  });

  it("falls back to the catalog default when nothing is stored", () => {
    const result = resolveEffectiveDocumentSettings("INVOICE", null, null);
    expect(result).toMatchObject({
      watermarkEnabled: true,
      watermarkText: null,
      qrEnabled: true,
      numberingPrefix: DOCUMENT_CATALOG.INVOICE.numbering.prefix,
      numberingYearlyReset: DOCUMENT_CATALOG.INVOICE.numbering.yearlyReset,
      sequencePadding: DOCUMENT_CATALOG.INVOICE.numbering.sequencePadding,
      hasOverride: false,
    });
  });

  it("resolves per-type override over global over catalog default (numbering prefix)", () => {
    const global = stored({ numberingPrefix: "GLOB" });
    const typeRow = stored({ docType: "INVOICE", numberingPrefix: "TAX" });
    expect(resolveEffectiveDocumentSettings("INVOICE", global, typeRow).numberingPrefix).toBe("TAX");
    expect(resolveEffectiveDocumentSettings("INVOICE", global, null).numberingPrefix).toBe("GLOB");
    expect(resolveEffectiveDocumentSettings("INVOICE", null, null).numberingPrefix).toBe(
      DOCUMENT_CATALOG.INVOICE.numbering.prefix,
    );
  });

  it("returns null watermark text when the watermark is disabled", () => {
    const typeRow = stored({ docType: "INVOICE", watermarkEnabled: false, watermarkText: "X" });
    const result = resolveEffectiveDocumentSettings("INVOICE", null, typeRow);
    expect(result.watermarkEnabled).toBe(false);
    expect(result.watermarkText).toBe("X"); // text preserved for the editor; disabled hides it
  });

  it("only allows include-attachments for attachment-supporting types", () => {
    const withAttach = stored({ printOptions: { includeAttachments: true } });
    // PATIENT_FILE supports attachments; REVENUE_REPORT does not.
    expect(
      resolveEffectiveDocumentSettings("PATIENT_FILE", withAttach, null).includeAttachments,
    ).toBe(true);
    expect(
      resolveEffectiveDocumentSettings("REVENUE_REPORT", withAttach, null).includeAttachments,
    ).toBe(false);
  });

  it("flags hasOverride only when a per-type row exists", () => {
    expect(resolveEffectiveDocumentSettings("INVOICE", null, null).hasOverride).toBe(false);
    expect(
      resolveEffectiveDocumentSettings("INVOICE", null, stored({ docType: "INVOICE" })).hasOverride,
    ).toBe(true);
  });
});

describe("P7-9 documentSettingsInputSchema", () => {
  it("accepts a valid per-type payload and trims empty watermark/prefix to null", () => {
    const parsed = documentSettingsInputSchema.parse({
      docType: "INVOICE",
      watermarkEnabled: true,
      watermarkText: "   ",
      qrEnabled: false,
      numberingPrefix: "",
      numberingYearlyReset: true,
      printOptions: {},
    });
    expect(parsed.watermarkText).toBeNull();
    expect(parsed.numberingPrefix).toBeNull();
    expect(parsed.docType).toBe("INVOICE");
    expect(parsed.qrEnabled).toBe(false);
  });

  it("accepts the global row (docType null)", () => {
    expect(documentSettingsInputSchema.parse({ docType: null }).docType).toBeNull();
  });

  it("rejects an unregistered document type", () => {
    expect(
      documentSettingsInputSchema.safeParse({ docType: "NOT_A_TYPE" }).success,
    ).toBe(false);
  });

  it("rejects a malformed numbering prefix", () => {
    expect(
      documentSettingsInputSchema.safeParse({ docType: "INVOICE", numberingPrefix: "bad prefix!" })
        .success,
    ).toBe(false);
    expect(
      documentSettingsInputSchema.safeParse({ docType: "INVOICE", numberingPrefix: "TOOLONGPREFIXVALUE" })
        .success,
    ).toBe(false);
  });

  it("rejects an over-length watermark", () => {
    expect(
      documentSettingsInputSchema.safeParse({
        docType: null,
        watermarkText: "x".repeat(161),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown print option keys (strict)", () => {
    expect(
      documentSettingsInputSchema.safeParse({
        docType: "PATIENT_FILE",
        printOptions: { includeAttachments: true, sneaky: 1 },
      }).success,
    ).toBe(false);
  });

  it("reset schema accepts null and a registered code, rejects an unknown code", () => {
    expect(documentSettingsResetSchema.safeParse({ docType: null }).success).toBe(true);
    expect(documentSettingsResetSchema.safeParse({ docType: "INVOICE" }).success).toBe(true);
    expect(documentSettingsResetSchema.safeParse({ docType: "NOPE" }).success).toBe(false);
  });
});
