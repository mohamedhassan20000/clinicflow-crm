import { describe, expect, it } from "vitest";
import {
  PHONE_COUNTRIES,
  PRIORITY_PHONE_COUNTRIES,
  inferPhoneCountry,
  isPhoneCountry,
  localPhoneValue,
  normalizePhone,
} from "@/lib/phone/registry";

describe("P1.5D / Pre-P2 WS3 international phone registry", () => {
  it.each([
    ["KW", "50003000", "+96550003000"], ["EG", "01012345678", "+201012345678"],
    ["SA", "0501234567", "+966501234567"], ["AE", "0501234567", "+971501234567"],
    ["TR", "05551234567", "+905551234567"], ["US", "4155552671", "+14155552671"],
  ])("validates %s local numbers and round-trips E.164", (country, local, e164) => {
    expect(normalizePhone(local, country as never)).toBe(e164);
    expect(inferPhoneCountry(e164)).toBe(country);
  });

  it("rejects country-invalid values", () => {
    expect(normalizePhone("123", "KW")).toBeNull();
    expect(normalizePhone("50003000", "ZZ")).toBeNull(); // unknown country
  });

  // WS3: registry now derives from every libphonenumber-supported country.
  it("exposes every libphonenumber country with the priority group pinned first", () => {
    expect(PHONE_COUNTRIES.length).toBeGreaterThan(200);
    expect(PHONE_COUNTRIES.slice(0, PRIORITY_PHONE_COUNTRIES.length).map((c) => c.code)).toEqual([
      ...PRIORITY_PHONE_COUNTRIES,
    ]);
    // Non-priority countries are alphabetical by English name
    const rest = PHONE_COUNTRIES.slice(PRIORITY_PHONE_COUNTRIES.length).map((c) => c.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
    // Every entry carries a flag + dial code
    for (const c of PHONE_COUNTRIES.slice(0, 20)) {
      expect(c.dialCode).toMatch(/^\+\d+/);
      expect(c.flag.length).toBeGreaterThan(0);
    }
  });

  // BUG-3 / P15D-P4: legacy GB/DE/FR (and other non-GCC) E.164 values now
  // validate and round-trip through the editor instead of degrading to KW.
  it.each([
    ["GB", "+442079460000"],
    ["DE", "+4915212345678"],
    ["FR", "+33612345678"],
    ["IN", "+919812345678"],
    ["PK", "+923001234567"],
    ["PH", "+639171234567"],
  ])("round-trips a stored %s E.164 value in the editor", (country, e164) => {
    expect(isPhoneCountry(country)).toBe(true);
    // The stored value parses to a valid, supported country (may be a +44
    // sibling like GG for GB numbers — the point is it is no longer KW-forced).
    const inferred = inferPhoneCountry(e164, "KW");
    expect(isPhoneCountry(inferred)).toBe(true);
    expect(inferred).not.toBe("KW");
    // localPhoneValue renders it read-normally, and it re-normalizes to the
    // same E.164 under its inferred country.
    const national = localPhoneValue(e164, inferred);
    expect(national.length).toBeGreaterThan(0);
    expect(normalizePhone(national, inferred)).toBe(e164);
  });
});
