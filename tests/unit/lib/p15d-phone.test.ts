import { describe, expect, it } from "vitest";
import { PHONE_COUNTRIES, inferPhoneCountry, normalizePhone } from "@/lib/phone/registry";

describe("P1.5D international phone registry", () => {
  it.each([
    ["KW", "50003000", "+96550003000"], ["EG", "01012345678", "+201012345678"],
    ["SA", "0501234567", "+966501234567"], ["AE", "0501234567", "+971501234567"],
    ["TR", "05551234567", "+905551234567"], ["US", "4155552671", "+14155552671"],
  ])("validates %s local numbers and round-trips E.164", (country, local, e164) => {
    expect(normalizePhone(local, country as never)).toBe(e164);
    expect(inferPhoneCountry(e164)).toBe(country);
  });

  it("rejects country-invalid values and exposes every planned country from one registry", () => {
    expect(normalizePhone("123", "KW")).toBeNull();
    expect(PHONE_COUNTRIES.map(({ code }) => code)).toEqual(["KW", "SA", "AE", "QA", "BH", "OM", "EG", "TR", "US"]);
  });
});

