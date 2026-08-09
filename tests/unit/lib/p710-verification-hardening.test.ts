import { describe, expect, it } from "vitest";
import {
  VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS,
  verificationDocumentTypeLabelKey,
} from "@/lib/documents/verification";
import { DOCUMENT_TYPE_CODES } from "@/lib/documents/catalog";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";

/**
 * P7-10 — public verification hardening. The public page names every issued
 * document type; before this phase the four P7-12 history/financial types fell
 * through to the generic "Document" label. The label map is now exhaustive by
 * construction (`Record<DocumentTypeCode, …>`); these tests lock that guarantee,
 * the AR/EN parity of the label keys, and the defensive fallback for unknown rows.
 */

type MessageTree = { documentPlatform: { verification: Record<string, unknown> } };
const enLabels = (en as unknown as MessageTree).documentPlatform.verification;
const arLabels = (ar as unknown as MessageTree).documentPlatform.verification;

describe("P7-10 public verification label hardening", () => {
  it("maps every registered document type to a specific (non-generic) label key", () => {
    for (const code of DOCUMENT_TYPE_CODES) {
      const key = verificationDocumentTypeLabelKey(code);
      expect(key).toBe(VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS[code]);
      expect(key).not.toBe("document");
    }
    // The record covers exactly the catalog — no missing or stray entries.
    expect(Object.keys(VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS).sort()).toEqual(
      [...DOCUMENT_TYPE_CODES].sort(),
    );
  });

  it("names the four P7-12 history/financial types instead of falling back (regression)", () => {
    expect(verificationDocumentTypeLabelKey("APPOINTMENT_HISTORY_REPORT")).toBe(
      "appointmentHistoryReport",
    );
    expect(verificationDocumentTypeLabelKey("PACKAGE_HISTORY_REPORT")).toBe("packageHistoryReport");
    expect(verificationDocumentTypeLabelKey("DEPOSIT_STATEMENT")).toBe("depositStatement");
    expect(verificationDocumentTypeLabelKey("PATIENT_FINANCIAL_SUMMARY")).toBe(
      "patientFinancialSummary",
    );
  });

  it("falls back to the generic label for null, unknown, or legacy type values", () => {
    expect(verificationDocumentTypeLabelKey(null)).toBe("document");
    expect(verificationDocumentTypeLabelKey("")).toBe("document");
    expect(verificationDocumentTypeLabelKey("RECEIPT")).toBe("document");
    expect(verificationDocumentTypeLabelKey("__proto__")).toBe("document");
  });

  it("resolves every label key in both AR and EN with full parity", () => {
    for (const code of DOCUMENT_TYPE_CODES) {
      const key = VERIFICATION_DOCUMENT_TYPE_LABEL_KEYS[code];
      expect(typeof enLabels[key]).toBe("string");
      expect((enLabels[key] as string).length).toBeGreaterThan(0);
      expect(typeof arLabels[key]).toBe("string");
      expect((arLabels[key] as string).length).toBeGreaterThan(0);
    }
    // The generic fallback label itself must exist in both locales.
    expect(typeof enLabels.document).toBe("string");
    expect(typeof arLabels.document).toBe("string");
  });
});
