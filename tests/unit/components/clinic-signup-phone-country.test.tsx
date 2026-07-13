import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClinicSignupForm } from "@/components/auth/clinic-signup-form";

vi.mock("@/actions/auth", () => ({ signUpClinic: vi.fn() }));

describe("ClinicSignupForm phone-country default", () => {
  it("follows the clinic country until the phone country is explicitly changed", async () => {
    const user = userEvent.setup();
    const { container } = render(<ClinicSignupForm defaults={{}} />);
    const clinicCountry = screen.getByLabelText("Country");
    const phoneCountry = screen.getByRole("combobox", { name: "Country calling code" });
    const submittedPhoneCountry = () =>
      container.querySelector<HTMLInputElement>('input[name="phoneCountry"]');

    expect(phoneCountry).toHaveTextContent("+965");
    expect(submittedPhoneCountry()).toHaveValue("KW");

    await user.selectOptions(clinicCountry, "SA");
    await waitFor(() => expect(phoneCountry).toHaveTextContent("+966"));
    expect(submittedPhoneCountry()).toHaveValue("SA");

    await user.click(phoneCountry);
    await user.type(screen.getByPlaceholderText("Search country or code…"), "United Arab Emirates");
    await user.click(screen.getByRole("option", { name: /United Arab Emirates/ }));
    expect(phoneCountry).toHaveTextContent("+971");
    expect(submittedPhoneCountry()).toHaveValue("AE");

    await user.selectOptions(clinicCountry, "EG");
    await waitFor(() => expect(phoneCountry).toHaveTextContent("+971"));
    expect(submittedPhoneCountry()).toHaveValue("AE");
  });
});
