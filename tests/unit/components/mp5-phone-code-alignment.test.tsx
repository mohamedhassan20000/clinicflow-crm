import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InternationalPhoneField } from "@/components/shared/international-phone-input";
import { PHONE_COUNTRIES } from "@/lib/phone/registry";

describe("Post-Pre-P2 MP5 phone calling-code alignment", () => {
  it("renders the longest country name in an accessible responsive grid", async () => {
    const user = userEvent.setup();
    render(<InternationalPhoneField name="phone" />);

    const trigger = screen.getByRole("combobox", { name: "Country calling code" });
    expect(trigger).toHaveClass("w-[132px]");
    await user.click(trigger);

    const search = screen.getByPlaceholderText("Search country or code…");
    const popover = search.closest('[data-slot="popover-content"]');
    expect(popover).toHaveClass("w-[min(280px,calc(100vw-2rem))]");

    const longest = PHONE_COUNTRIES.reduce((current, country) =>
      country.name.length > current.name.length ? country : current,
    );
    await user.type(search, longest.name);

    const option = screen.getByRole("option", { name: new RegExp(longest.name, "i") });
    expect(option).toHaveAccessibleName(new RegExp(longest.code));
    expect(option).toHaveAccessibleName(
      new RegExp(longest.dialCode.replace("+", "\\+")),
    );

    const grid = option.querySelector(".phone-cc-grid");
    const [flag, name, code, dial] = Array.from(grid?.children ?? []);

    expect(grid).toHaveClass("phone-cc-grid");
    expect(flag).toHaveAttribute("aria-hidden");
    expect(name).toHaveTextContent(longest.name);
    expect(code).toHaveTextContent(longest.code);
    expect(dial).toHaveTextContent(longest.dialCode);
  });

  it("keeps filtering, keyboard selection, E.164 emission, and hidden inputs intact", async () => {
    const user = userEvent.setup();
    const { container } = render(<InternationalPhoneField name="phone" />);
    const trigger = screen.getByRole("combobox", { name: "Country calling code" });

    await user.click(trigger);
    const search = screen.getByPlaceholderText("Search country or code…");
    await user.type(search, "united");
    const filteredOptions = screen.getAllByRole("option");
    expect(filteredOptions.length).toBeGreaterThan(1);
    expect(filteredOptions.every((option) => /united/i.test(option.textContent ?? ""))).toBe(true);

    await user.type(search, " kingdom");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveTextContent("+44");
    expect(container.querySelector('input[name="phoneCountry"]')).toHaveValue("GB");

    await user.type(screen.getByPlaceholderText("Local number"), "2079460000");
    expect(container.querySelector('input[name="phone"]')).toHaveValue("+442079460000");

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
