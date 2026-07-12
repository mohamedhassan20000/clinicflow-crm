import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InternationalPhoneField } from "@/components/shared/international-phone-input";

describe("InternationalPhoneField FormData contract", () => {
  it("submits normalized E.164 and the selected country", () => {
    let submitted: Record<string, FormDataEntryValue> = {};
    render(<form onSubmit={(event) => { event.preventDefault(); submitted = Object.fromEntries(new FormData(event.currentTarget)); }}><InternationalPhoneField name="phone" defaultCountry="SA" /><button type="submit">Submit</button></form>);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "0501234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted.phone).toBe("+966501234567");
    expect(submitted.phoneCountry).toBe("SA");
  });
});
