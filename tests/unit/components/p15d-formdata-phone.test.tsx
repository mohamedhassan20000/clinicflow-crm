import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  InternationalPhoneField,
  InternationalPhoneInput,
} from "@/components/shared/international-phone-input";

describe("InternationalPhoneField FormData contract", () => {
  it("submits normalized E.164 and the selected country", () => {
    let submitted: Record<string, FormDataEntryValue> = {};
    render(<form onSubmit={(event) => { event.preventDefault(); submitted = Object.fromEntries(new FormData(event.currentTarget)); }}><InternationalPhoneField name="phone" defaultCountry="SA" /><button type="submit">Submit</button></form>);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "0501234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(submitted.phone).toBe("+966501234567");
    expect(submitted.phoneCountry).toBe("SA");
  });

  it("resyncs country and local digits when a controlled value changes externally", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <InternationalPhoneInput value="+96550003000" onChange={onChange} />,
    );
    expect(screen.getByRole("combobox", { name: "Country calling code" })).toHaveTextContent(
      "+965",
    );

    rerender(<InternationalPhoneInput value="+442079460000" onChange={onChange} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Country calling code" })).toHaveTextContent(
        "+44",
      ),
    );
    expect(screen.getByRole("textbox")).toHaveValue("020 7946 0000");
    expect(onChange).not.toHaveBeenCalled();
  });
});
