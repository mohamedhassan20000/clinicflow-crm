import { describe, expect, it, vi } from "vitest";

/**
 * P11 — the presentation contract.
 *
 * The device failure this locks down: the server returned one Dermatology
 * doctor and the patient was shown two. Nothing in the query was wrong, so no
 * amount of query testing could have caught it — the extra name entered between
 * the last tool result and the sent message, which is a region the system had
 * no assertion in at all.
 *
 * As everywhere else in this phase, the fixtures are invented departments and
 * invented people. The contract is about membership, not about medicine.
 */

vi.mock("server-only", () => ({}));

import {
  buildDeterministicRosterReply,
  buildGroundingCorrection,
  checkDoctorGrounding,
  createGroundingLedger,
  titledMentions,
} from "@/lib/ai/patient-grounding";

const CLINIC_DOCTORS = [
  { id: "1", name: "Rana Wasfy" },
  { id: "2", name: "Tarek Sobhy" },
  { id: "3", name: "Hoda Fahmy" },
  { id: "4", name: "بسمة راغب" },
  { id: "5", name: "سامي عبد الله" },
];

function check(text: string, allowed: string[]) {
  return checkDoctorGrounding({
    text,
    allowedNames: allowed,
    clinicDoctors: CLINIC_DOCTORS,
  });
}

describe("P11 §16 · the ledger records what the server returned", () => {
  it("collects doctors, departments and services from real tool shapes", () => {
    const ledger = createGroundingLedger();
    ledger.record("prepare_booking", {
      department: { id: "d", name: "Gamma Unit" },
      doctors: [
        { id: "1", name: "Rana Wasfy" },
        { id: "2", name: "Tarek Sobhy" },
      ],
      doctor_count: 2,
    });
    ledger.record("list_department_services", {
      department: { id: "d", name: "Gamma Unit" },
      services: [{ name: "Consultation", price: 400 }],
    });
    expect([...ledger.names("doctor")].sort()).toEqual(["Rana Wasfy", "Tarek Sobhy"]);
    expect(ledger.names("department")).toEqual(["Gamma Unit"]);
    expect(ledger.names("service")).toEqual(["Consultation"]);
    expect([...ledger.doctorIds()].sort()).toEqual(["1", "2"]);
    expect(ledger.sawDoctors()).toBe(true);
  });

  it("does not promote departments, services or insurers into the doctor set", () => {
    const ledger = createGroundingLedger();
    ledger.record("list_clinic_insurance", {
      insurers: [{ id: "i", name: "Rana Wasfy" }],
      departments: [{ id: "d", name: "Gamma Unit" }],
    });
    expect(ledger.names("doctor")).toEqual([]);
    expect(ledger.sawDoctors()).toBe(false);
  });

  it("records the doctor named on an appointment row", () => {
    const ledger = createGroundingLedger();
    ledger.record("lookup_appointment", {
      appointments: [{ doctor_name: "Hoda Fahmy", department_name: "Gamma Unit" }],
    });
    expect(ledger.names("doctor")).toEqual(["Hoda Fahmy"]);
  });

  it("keeps `candidates` in the kind its own `field` names", () => {
    const doctorSide = createGroundingLedger();
    doctorSide.record("prepare_booking", {
      field: "doctor",
      candidates: [{ id: "1", name: "Rana Wasfy" }],
    });
    expect(doctorSide.names("doctor")).toEqual(["Rana Wasfy"]);

    const departmentSide = createGroundingLedger();
    departmentSide.record("prepare_booking", {
      field: "department",
      candidates: [{ id: "d", name: "Gamma Unit" }],
    });
    expect(departmentSide.names("doctor")).toEqual([]);
  });
});

describe("P11 §16 · a reply may not name a doctor the server did not return", () => {
  it("passes a reply that names exactly the offered roster", () => {
    const result = check(
      "الدكاترة المتاحين في القسم: د. Rana Wasfy و د. Tarek Sobhy. تحب تحجز مع مين؟",
      ["Rana Wasfy", "Tarek Sobhy"],
    );
    expect(result.grounded).toBe(true);
  });

  it("catches the reported defect: one doctor returned, two presented", () => {
    const result = check(
      "الدكاترة المتاحين: 1. د. Rana Wasfy 2. د. Hoda Fahmy",
      ["Rana Wasfy"],
    );
    expect(result.grounded).toBe(false);
    expect(result.violations.map((item) => item.mention)).toContain("Hoda Fahmy");
  });

  it("catches a real staff name listed with no title at all", () => {
    const result = check("1. Rana Wasfy\n2. Tarek Sobhy", ["Rana Wasfy"]);
    expect(result.grounded).toBe(false);
    expect(result.violations[0]!.source).toBe("clinic_directory");
  });

  it("catches an invented name that is in no table anywhere", () => {
    const result = check("Available now: Dr Fatima Khalil.", ["Rana Wasfy"]);
    expect(result.grounded).toBe(false);
    expect(result.violations[0]!.source).toBe("titled_mention");
  });

  it("catches an Arabic invented name", () => {
    const result = check("الدكتورة نادية شوقي متاحة بكرة.", ["بسمة راغب"]);
    expect(result.grounded).toBe(false);
  });

  it("flags a doctor from another department who was never offered", () => {
    const result = check("تقدر تحجز مع د. بسمة راغب.", ["Rana Wasfy"]);
    expect(result.grounded).toBe(false);
    expect(result.violations[0]!.source).toBe("clinic_directory");
  });

  it("flags any doctor name at all when the server returned none", () => {
    expect(check("د. Rana Wasfy متاحة النهاردة", []).grounded).toBe(false);
  });

  it("does not flag ordinary prose that merely contains a title", () => {
    for (const text of [
      "الدكتور المعالج بتاعك هو د. Rana Wasfy.",
      "Your treating doctor is Dr Rana Wasfy.",
      "الدكتور المتاح حاليًا هو د. Rana Wasfy، تحب أحجزلك؟",
      "تمام، هبعتلك المواعيد المتاحة.",
      "",
    ]) {
      expect(check(text, ["Rana Wasfy"]).grounded, text).toBe(true);
    }
  });

  it("tolerates a small spelling difference in a name it did return", () => {
    expect(check("د. Rana Wasfi متاحة", ["Rana Wasfy"]).grounded).toBe(true);
  });

  it("reads a name span up to the first separator only", () => {
    expect(titledMentions("Dr Rana Wasfy, Dr Tarek Sobhy")).toEqual([
      "Rana Wasfy",
      "Tarek Sobhy",
    ]);
  });
});

describe("P11 §16 · repair is grounded, conversational, and in the right language", () => {
  it("states the permitted set rather than repeating a rule", () => {
    const correction = buildGroundingCorrection({
      locale: "ar",
      allowedNames: ["Rana Wasfy", "Tarek Sobhy"],
      violations: [{ mention: "Hoda Fahmy", source: "clinic_directory" }],
    });
    expect(correction).toContain("Rana Wasfy");
    expect(correction).toContain("Tarek Sobhy");
    expect(correction).toContain("Hoda Fahmy");
  });

  it("tells the model to name nobody when the server returned nobody", () => {
    const correction = buildGroundingCorrection({
      locale: "en",
      allowedNames: [],
      violations: [{ mention: "Fatima Khalil", source: "titled_mention" }],
    });
    expect(correction).toContain("name no doctor at all");
  });

  it("composes the deterministic fallback from the roster itself", () => {
    expect(
      buildDeterministicRosterReply({
        locale: "ar",
        departmentName: "Gamma Unit",
        doctors: ["Rana Wasfy", "Tarek Sobhy"],
        departments: [],
      }),
    ).toBe("الدكاترة المتاحين في Gamma Unit:\n1. Rana Wasfy\n2. Tarek Sobhy\nتحب تحجز مع مين؟");

    expect(
      buildDeterministicRosterReply({
        locale: "en",
        departmentName: "Gamma Unit",
        doctors: ["Rana Wasfy"],
        departments: [],
      }),
    ).toContain("The doctor currently available in Gamma Unit is Rana Wasfy");

    expect(
      buildDeterministicRosterReply({
        locale: "en",
        departmentName: "Gamma Unit",
        doctors: [],
        departments: ["Gamma Unit"],
      }),
    ).toContain("no bookable doctor in Gamma Unit");

    expect(
      buildDeterministicRosterReply({
        locale: "ar",
        departmentName: null,
        doctors: [],
        departments: ["Gamma Unit", "قسم بيتا"],
      }),
    ).toContain("1. Gamma Unit\n2. قسم بيتا");
  });

  it("every deterministic reply names only what it was given", () => {
    const reply = buildDeterministicRosterReply({
      locale: "en",
      departmentName: "Gamma Unit",
      doctors: ["Rana Wasfy"],
      departments: [],
    });
    expect(
      checkDoctorGrounding({
        text: reply,
        allowedNames: ["Rana Wasfy"],
        clinicDoctors: CLINIC_DOCTORS,
      }).grounded,
    ).toBe(true);
  });
});
