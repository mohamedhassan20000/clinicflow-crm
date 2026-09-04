import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseRelativeDay } from "@/lib/ai/human-input";
import { createGroundingLedger } from "@/lib/ai/patient-grounding";
import {
  enforcePatientFactReply,
  formatPatientTime,
} from "@/lib/ai/patient-fact-reply";
import { enforcePatientWriteReply } from "@/lib/ai/patient-write-commit";

describe("manual QA · deterministic patient presentation", () => {
  it("keeps configured service names exact instead of substituting department labels", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_department_services", {
      found: true,
      scope: "all_departments",
      currency: "EGP",
      departments: [
        { name: "Dermatology", services: [{ id: "s1", name: "Skin Consultation", price: 500 }] },
        { name: "Cardiology", services: [{ id: "s2", name: "Cardiology Examination", price: 700 }] },
        { name: "Physical Therapy", services: [{ id: "s3", name: "Physical Therapy Assessment", price: 350 }] },
      ],
    });
    const reply = enforcePatientFactReply({ locale: "ar", text: "ignored", ledger }).text;
    expect(reply).toContain("Skin Consultation — 500 EGP");
    expect(reply).toContain("Cardiology Examination — 700 EGP");
    expect(reply).toContain("Physical Therapy Assessment — 350 EGP");
    expect(reply).not.toContain("الجلدية — 500 EGP");
    expect(reply).not.toContain("القلب — 700 EGP");
  });

  it("renders a complete grouped roster without turning it into a booking question", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_doctors", {
      scope: "all_departments",
      departments: [
        { name: "Dermatology", doctors: [{ name: "Omar Hassan" }, { name: "Youssef Ali" }] },
        { name: "Cardiology", doctors: [{ name: "Mona Adel" }] },
      ],
    });
    const reply = enforcePatientFactReply({ locale: "en", text: "ignored", ledger, rosterOnly: true }).text;
    expect(reply).toContain("Doctors by department");
    expect(reply).toContain("Dermatology:\n1. Omar Hassan\n2. Youssef Ali");
    expect(reply).toContain("Cardiology:\n1. Mona Adel");
    expect(reply).not.toMatch(/who would you like|want to book/i);
  });

  it("answers a date availability question first, then shows every slot after confirmation", () => {
    const ledger = createGroundingLedger();
    const slots = ["09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "13:00"];
    ledger.record("check_availability", {
      ok: true,
      date: "2026-09-10",
      doctor_name: "Omar Hassan",
      availableSlots: slots,
      time_format: "12h",
    });
    const yesNo = enforcePatientFactReply({
      locale: "en",
      text: "ignored",
      ledger,
      latestPatientText: "Is next Thursday available?",
    }).text;
    expect(yesNo).toContain("Yes, appointments are available");
    expect(yesNo).not.toContain("9:00 AM");

    const confirmedLedger = createGroundingLedger();
    confirmedLedger.record("check_availability", {
      ok: true,
      date: "2026-09-10",
      doctor_name: "Omar Hassan",
      availableSlots: slots,
      date_from_memory: true,
      time_format: "12h",
    });
    const confirmed = enforcePatientFactReply({
      locale: "en",
      text: "ignored",
      ledger: confirmedLedger,
      latestPatientText: "yes",
    }).text;
    for (const time of slots) expect(confirmed).toContain(formatPatientTime(time, "en"));
    expect(confirmed).not.toContain("more options");
  });

  it("applies 12h/24h display preferences and keeps Arabic noon in the evening period", () => {
    expect(formatPatientTime("13:00", "en", "24h")).toBe("13:00");
    expect(formatPatientTime("13:00", "en", "12h")).toBe("1:00 PM");
    expect(formatPatientTime("12:00", "ar", "12h")).toBe("12:00 مساءً");
  });

  it("resolves next weekday strictly in the future in the clinic timezone", () => {
    const thursday = new Date("2026-09-10T09:00:00Z");
    expect(parseRelativeDay("next Thursday", { now: thursday, timeZone: "UTC" }))
      .toBe("2026-09-17");
    expect(parseRelativeDay("الخميس الجاي", { now: new Date("2026-09-07T09:00:00Z"), timeZone: "UTC" }))
      .toBe("2026-09-10");
  });

  it("continues staged intake directly into availability without a second approval gate", () => {
    const ledger = createGroundingLedger();
    ledger.record("register_patient", { intake_staged: true, intake_id: "11111111-1111-4111-8111-111111111111" });
    ledger.record("list_available_days", { ok: true, availableDays: [{ date: "2026-09-10" }] });
    const result = enforcePatientWriteReply({
      locale: "en",
      text: "Available days:\n- Thursday, 10 September 2026\nWhich day suits you?",
      authority: null,
      ledger,
    });
    expect(result.text).toContain("awaiting clinic review");
    expect(result.text).toContain("Available days");
    expect(result.text).not.toMatch(/confirm that you want it submitted/i);
  });
});
