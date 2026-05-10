import { describe, expect, it } from "vitest";
import {
  formatPatientPhoneForInput,
  inferPhoneCountry,
  normalizePatientPhone,
} from "@/lib/patient-phone";

describe("patient phone utilities", () => {
  it("normalizes Turkish mobile numbers to E.164", () => {
    expect(normalizePatientPhone("0555 123 45 67")).toBe("+905551234567");
    expect(normalizePatientPhone("+90 (555) 123 45 67")).toBe("+905551234567");
  });

  it("formats existing saved Turkish numbers for friendly editing", () => {
    expect(formatPatientPhoneForInput("05551234567")).toBe("+90 (555) 123 45 67");
    expect(formatPatientPhoneForInput("+905551234567")).toBe("+90 (555) 123 45 67");
  });

  it("accepts valid international E.164 numbers", () => {
    expect(normalizePatientPhone("+1 415 555 2671")).toBe("+14155552671");
    expect(inferPhoneCountry("+14155552671")).toBe("US");
  });

  it("rejects obvious invalid phone numbers", () => {
    expect(normalizePatientPhone("123")).toBeNull();
    expect(normalizePatientPhone("+000 123")).toBeNull();
  });
});
