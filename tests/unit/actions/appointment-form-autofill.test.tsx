import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentForm } from "@/components/appointments/appointment-form";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const DEPARTMENT_ID = "33333333-3333-4333-8333-333333333333";
const DOCTOR_ID = "44444444-4444-4444-8444-444444444444";
const PATIENT_INSURANCE_ID = "55555555-5555-4555-8555-555555555555";
const MANUAL_INSURANCE_ID = "66666666-6666-4666-8666-666666666666";

function renderAppointmentForm() {
  return render(
    <AppointmentForm
      action={vi.fn(async () => ({}))}
      patients={[
        {
          id: PATIENT_ID,
          full_name: "Insured Patient",
          phone: "0555 123 45 67",
          department_id: DEPARTMENT_ID,
          assigned_doctor_id: DOCTOR_ID,
          insurance_provider_id: PATIENT_INSURANCE_ID,
          national_id: "ABC123",
          file_number: "CF-0001",
        },
      ]}
      doctors={[
        {
          id: DOCTOR_ID,
          full_name: "Doctor One",
          department_id: DEPARTMENT_ID,
        },
      ]}
      departments={[{ id: DEPARTMENT_ID, name: "Cardiology" }]}
      insuranceProviders={[
        { id: PATIENT_INSURANCE_ID, name: "Acme Insurance" },
        { id: MANUAL_INSURANCE_ID, name: "Manual Insurance" },
      ]}
    />,
  );
}

async function selectPatient(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: /patient/i }));
  await user.click(await screen.findByText("Insured Patient"));
}

async function selectInsurance(
  user: ReturnType<typeof userEvent.setup>,
  providerName: string,
) {
  await user.click(screen.getByRole("combobox", { name: /insurance/i }));
  const listbox = await screen.findByRole("listbox");
  await user.click(within(listbox).getByText(providerName));
}

function expectSelectedInsurance(providerName: string) {
  expect(
    screen
      .getAllByText(providerName)
      .some((element) => element.getAttribute("data-slot") === "select-value"),
  ).toBe(true);
}

describe("appointment form patient context autofill", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("autofills patient insurance when selecting a patient", async () => {
    const user = userEvent.setup();
    renderAppointmentForm();

    await selectPatient(user);

    expectSelectedInsurance("Acme Insurance");
  });

  it("does not overwrite a manually selected insurance provider after patient selection", async () => {
    const user = userEvent.setup();
    renderAppointmentForm();

    await selectInsurance(user, "Manual Insurance");
    await selectPatient(user);

    expectSelectedInsurance("Manual Insurance");
  });

  it("positions the time dropdown with popper alignment under its field", async () => {
    const user = userEvent.setup();
    renderAppointmentForm();

    await user.click(screen.getByRole("combobox", { name: /time/i }));

    const listbox = await screen.findByRole("listbox");
    expect(
      listbox.closest("[data-slot='select-content']"),
    ).toHaveAttribute("data-align-trigger", "false");
  });
});
