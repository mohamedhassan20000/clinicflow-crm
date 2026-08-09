import { describe, expect, it } from "vitest";
import {
  documentNumberingLocale,
  formatDocDate,
  formatDocIdentifier,
  formatDocMoney,
  formatDocNumber,
  formatDocPercent,
  formatDocTime,
  formatDocumentNumber,
  toLatinDigits,
} from "@/lib/documents/format";
import {
  bidiIsolateProps,
  isolateBidiText,
  isolateLtrAtom,
} from "@/lib/documents/bidi";

const NON_LATIN_DIGITS = /[٠-٩۰-۹]/;

describe("P7-0 document formatting", () => {
  it("normalizes both Arabic digit ranges in textual identifiers", () => {
    expect(toLatinDigits("INV-٢٠٢٦-۰۰۴۲")).toBe("INV-2026-0042");
    expect(formatDocIdentifier(" +٩٦٥ ٥٥٥ ۱۲۳ ")).toBe("+965 555 123");
  });

  it("forces Latin digits for Arabic number, money, percent, date, and time", () => {
    const locale = {
      locale: "ar",
      timeZone: "UTC",
      currency: "KWD",
      timeFormat: "24h" as const,
    };
    const values = [
      formatDocNumber(12345.67, locale),
      formatDocMoney(12345.67, locale),
      formatDocPercent(0.375, locale),
      formatDocDate("2026-08-01T13:45:00.000Z", locale),
      formatDocTime("2026-08-01T13:45:00.000Z", locale),
    ];

    expect(documentNumberingLocale("ar")).toContain("nu-latn");
    for (const value of values) {
      expect(value).not.toMatch(NON_LATIN_DIGITS);
      expect(value).toMatch(/[0-9]/);
    }
  });

  it("freezes the approved catalog number shape", () => {
    expect(formatDocumentNumber({
      prefix: "REV",
      periodKey: "2026",
      sequence: 7,
    })).toBe("REV-2026-0007");
    expect(formatDocumentNumber({
      prefix: "RX",
      sequence: 142,
      padding: 6,
    })).toBe("RX-000142");
  });

  it("omits unnecessary money decimals while preserving real fractional amounts", () => {
    const locale = { locale: "en", currency: "TRY", timeZone: "UTC", timeFormat: "24h" as const };
    expect(formatDocMoney(17650, locale, { currencyDisplay: "code" })).toContain("17,650");
    expect(formatDocMoney(17650, locale, { currencyDisplay: "code" })).not.toContain(".00");
    expect(formatDocMoney(17650.5, locale, { currencyDisplay: "code" })).toContain("17,650.5");
  });

  it("provides HTML and plain-text bidi isolation helpers", () => {
    expect(bidiIsolateProps("ltr")).toEqual({
      dir: "ltr",
      style: { unicodeBidi: "isolate" },
    });
    expect(isolateBidiText("مرحبا", "rtl")).toBe("\u2067مرحبا\u2069");
    expect(isolateLtrAtom("RX-٢٠٢٦-١")).toBe("\u2066RX-2026-1\u2069");
  });
});
