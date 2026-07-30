import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import ar from "@/messages/ar.json";

describe("appointment insurance localization", () => {
  it.each([
    "insuranceContribution",
    "patientResponsibility",
    "insuranceModeAmount",
    "insuranceModePercentage",
    "insurancePercentageMustBeBetween",
    "patientPaymentsCannotExceedResponsibility",
    "fillRemaining",
  ] as const)("provides English and Arabic copy for %s", (key) => {
    expect(en.appointments[key]).toBeTruthy();
    expect(ar.appointments[key]).toBeTruthy();
    expect(ar.appointments[key]).not.toBe(en.appointments[key]);
  });

  it.each([
    "insuranceContribution",
    "patientResponsibility",
    "totalPatientPaid",
    "remainingPatientBalance",
  ] as const)("localizes saved and printable invoice label %s", (key) => {
    expect(en.patients[key]).toBeTruthy();
    expect(ar.patients[key]).toBeTruthy();
    expect(ar.patients[key]).not.toBe(en.patients[key]);
  });
});
