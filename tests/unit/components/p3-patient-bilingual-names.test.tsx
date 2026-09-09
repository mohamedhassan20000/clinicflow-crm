/**
 * The patient's bilingual display names, on the staff surface.
 *
 * The property that matters most is the boring one (**O**): a record created
 * before these columns existed, and a database where the additive migration has
 * not been applied, must both render and save exactly as they do today. The two
 * fields are optional in the schema, blank is dropped from the payload rather
 * than written as `""`, and `full_name` stays canonical — it is what search,
 * billing, the audit trail and every identity check read.
 */

import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PatientForm } from "@/components/patients/patient-form";
import { patientSchema } from "@/lib/validations/patient";
import { stripBlankDisplayNames } from "@/lib/settings/display-names";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const VALID = {
  full_name: "Ali Alzahrani",
  national_id: "29001012345678",
  date_of_birth: "2003-04-02",
  phone: "+201002003040",
  email: "ali@example.com",
  blood_type: null,
  department_id: null,
  assigned_doctor_id: null,
  insurance_provider_id: null,
};

function field(name: string): HTMLInputElement {
  return document.querySelector(`[name="${name}"]`) as HTMLInputElement;
}

describe("O: a patient with no bilingual names is valid and unchanged", () => {
  it("validates a payload that names neither", () => {
    expect(patientSchema.safeParse(VALID).success).toBe(true);
  });

  it("validates a payload that names both", () => {
    const parsed = patientSchema.safeParse({
      ...VALID,
      full_name_ar: "علي الزهراني",
      full_name_en: "Ali Alzahrani",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an explicit null for either", () => {
    expect(
      patientSchema.safeParse({ ...VALID, full_name_ar: null, full_name_en: null }).success,
    ).toBe(true);
  });

  it("still requires the canonical name", () => {
    const parsed = patientSchema.safeParse({
      ...VALID,
      full_name: "",
      full_name_ar: "علي الزهراني",
    });
    // A display name is not a name. Nothing may satisfy `full_name` but
    // `full_name`, because that column is what identity folds.
    expect(parsed.success).toBe(false);
  });

  it("drops a blank display name from the write entirely", () => {
    // Not `""`. A clinic that authored nothing sends byte-for-byte the payload
    // it sent before the columns existed, which is what lets the write work on
    // a database where the migration has not run.
    expect(stripBlankDisplayNames({ ...VALID, full_name_ar: "", full_name_en: "  " })).toEqual(
      VALID,
    );
  });
});

describe("the patient form carries both names, in their own direction", () => {
  function setup(defaults?: Record<string, unknown>) {
    render(
      <PatientForm
        action={vi.fn(async () => ({ success: true }))}
        departments={[]}
        doctors={[]}
        insuranceProviders={[]}
        defaultValues={defaults as never}
      />,
    );
  }

  it("renders both fields, empty, for a new patient", () => {
    setup();
    expect(field("full_name_ar")).toHaveValue("");
    expect(field("full_name_en")).toHaveValue("");
    expect(field("full_name_ar")).toHaveAttribute("dir", "rtl");
    expect(field("full_name_en")).toHaveAttribute("dir", "ltr");
  });

  it("renders an older record that has neither, without breaking", () => {
    setup({ full_name: "Ali Alzahrani", national_id: "29001012345678" });
    expect(field("full_name")).toHaveValue("Ali Alzahrani");
    expect(field("full_name_ar")).toHaveValue("");
  });

  it("shows the names a clinic has authored", async () => {
    setup({
      full_name: "Ali Alzahrani",
      full_name_ar: "علي الزهراني",
      full_name_en: "Ali Alzahrani",
    });
    expect(field("full_name_ar")).toHaveValue("علي الزهراني");
    const user = userEvent.setup();
    await user.clear(field("full_name_ar"));
    await user.type(field("full_name_ar"), "علي محمد الزهراني");
    expect(field("full_name_ar")).toHaveValue("علي محمد الزهراني");
  });
});
