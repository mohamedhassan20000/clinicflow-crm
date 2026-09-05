/**
 * Item #3 — a beneficiary who is already a patient here is recognised as one.
 *
 * ## The defect
 *
 * A third-party beneficiary who already had a file at this clinic, with the
 * same authoritative identity number, was treated as a stranger: the assistant
 * asked which department she wanted and headed towards opening a second file.
 *
 * Nothing could have found her. The only existing-patient reuse in the system
 * is keyed on the *sender's phone*, and a beneficiary is by definition not the
 * person holding the handset.
 *
 * ## What is pinned here
 *
 * The pure decision layer: given what the lookup returns, what does the booking
 * do next. The identity rule itself (exact folded id, name as confirmation,
 * ambiguity fails closed) lives in
 * `20260911120000_existing_patient_identity_discovery.sql` and is asserted in
 * `tests/unit/db/`.
 */
import { describe, expect, it } from "vitest";

import {
  discoveryFromRelationships,
  type PatientRelationshipRow,
} from "@/lib/ai/existing-patient-discovery";

const PATIENT = "66666666-6666-4666-8666-666666666666";
const DERM = "33333333-3333-4333-8333-333333333333";
const CARDIO = "44444444-4444-4444-8444-444444444444";
const D_NABIL = "aaaaaaaa-0000-4000-8000-000000000001";
const D_SARA = "aaaaaaaa-0000-4000-8000-000000000002";

function row(over: Partial<PatientRelationshipRow> = {}): PatientRelationshipRow {
  return {
    patient_id: PATIENT,
    full_name: "جهاد علي",
    department_id: DERM,
    department_name: "الجلدية",
    doctor_id: D_NABIL,
    doctor_name: "أحمد نبيل",
    is_primary: true,
    ...over,
  };
}

describe("no match", () => {
  it("is not an existing patient when the lookup returns nothing", () => {
    expect(discoveryFromRelationships([])).toEqual({ kind: "none" });
  });
});

describe("case A — one department, one treating doctor", () => {
  it("offers the same department and the same doctor", () => {
    expect(discoveryFromRelationships([row()])).toEqual({
      kind: "single_department",
      patientId: PATIENT,
      patientName: "جهاد علي",
      department: { id: DERM, name: "الجلدية" },
      treatingDoctor: { id: D_NABIL, name: "أحمد نبيل" },
      departments: [{ id: DERM, name: "الجلدية" }],
    });
  });

  it("offers the department alone when no bookable doctor is attached", () => {
    const result = discoveryFromRelationships([
      row({ doctor_id: null, doctor_name: null }),
    ]);
    expect(result).toMatchObject({
      kind: "single_department",
      treatingDoctor: null,
      department: { id: DERM },
    });
  });

  it("prefers the primary relationship as the treating doctor", () => {
    const result = discoveryFromRelationships([
      row({ doctor_id: D_SARA, doctor_name: "سارة علي", is_primary: false }),
      row({ doctor_id: D_NABIL, doctor_name: "أحمد نبيل", is_primary: true }),
    ]);
    expect(result).toMatchObject({
      kind: "single_department",
      treatingDoctor: { id: D_NABIL },
    });
  });
});

describe("case B — more than one department", () => {
  it("asks which department rather than choosing one", () => {
    const result = discoveryFromRelationships([
      row(),
      row({ department_id: CARDIO, department_name: "القلب", doctor_id: D_SARA, doctor_name: "سارة علي", is_primary: false }),
    ]);
    expect(result).toMatchObject({
      kind: "multiple_departments",
      patientId: PATIENT,
      departments: [
        { id: DERM, name: "الجلدية" },
        { id: CARDIO, name: "القلب" },
      ],
    });
    expect(result).not.toHaveProperty("treatingDoctor");
  });

  it("still knows the treating doctor for each department", () => {
    const result = discoveryFromRelationships([
      row(),
      row({ department_id: CARDIO, department_name: "القلب", doctor_id: D_SARA, doctor_name: "سارة علي", is_primary: false }),
    ]);
    expect(result.kind).toBe("multiple_departments");
    if (result.kind !== "multiple_departments") return;
    expect(result.treatingDoctorByDepartment[DERM]).toEqual({
      id: D_NABIL,
      name: "أحمد نبيل",
    });
    expect(result.treatingDoctorByDepartment[CARDIO]).toEqual({
      id: D_SARA,
      name: "سارة علي",
    });
  });

  it("names no doctor for a department that has no bookable one", () => {
    const result = discoveryFromRelationships([
      row(),
      row({ department_id: CARDIO, department_name: "القلب", doctor_id: null, doctor_name: null, is_primary: false }),
    ]);
    if (result.kind !== "multiple_departments") throw new Error("expected two departments");
    expect(result.treatingDoctorByDepartment[CARDIO]).toBeUndefined();
  });
});

describe("what the discovery must never do", () => {
  it("never names a department twice", () => {
    const result = discoveryFromRelationships([
      row(),
      row({ doctor_id: D_SARA, doctor_name: "سارة علي", is_primary: false }),
    ]);
    expect(result).toMatchObject({ kind: "single_department" });
    expect(result.kind === "single_department" && result.departments).toHaveLength(1);
  });

  it("carries no contact detail, no history and no file number", () => {
    const result = discoveryFromRelationships([row()]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("email");
    expect(serialized).not.toContain("national");
    expect(serialized).not.toContain("file_number");
  });
});
