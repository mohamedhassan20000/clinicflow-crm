import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportFilterCombobox } from "@/components/operator/report-filter-combobox";
import { CurrencyCombobox } from "@/components/settings/currency-combobox";
import { InternationalPhoneField } from "@/components/shared/international-phone-input";

const { refresh, updateDisplayCurrency } = vi.hoisted(() => ({
  refresh: vi.fn(),
  updateDisplayCurrency: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/actions/profile", () => ({ updateDisplayCurrency }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe("shared searchable combobox consumers", () => {
  beforeEach(() => {
    refresh.mockReset();
    updateDisplayCurrency.mockReset();
    updateDisplayCurrency.mockResolvedValue({});
  });

  it("searches and selects a phone country", async () => {
    const user = userEvent.setup();
    const { container } = render(<InternationalPhoneField name="phone" />);

    await user.click(screen.getByRole("combobox", { name: "Country calling code" }));
    await user.type(screen.getByPlaceholderText("Search country or code…"), "United Kingdom");
    await user.click(screen.getByRole("option", { name: /United Kingdom/ }));

    expect(screen.getByRole("combobox", { name: "Country calling code" })).toHaveTextContent("+44");
    expect(container.querySelector('input[name="phoneCountry"]')).toHaveValue("GB");
  });

  it("searches and persists a display currency", async () => {
    const user = userEvent.setup();
    render(<CurrencyCombobox value="KWD" />);

    await user.click(screen.getByRole("combobox", { name: "Display currency" }));
    await user.type(screen.getByPlaceholderText("Search currency or code…"), "US Dollar");
    const option = screen.getByRole("option", { name: /US Dollar/ });
    const grid = option.querySelector(".currency-option-grid");
    const [symbol, name, countryCode, currencyCode] = Array.from(grid?.children ?? []);

    expect(grid).toHaveClass(
      "grid-cols-[2.75rem_minmax(0,1fr)_2.5rem_3.25rem]",
    );
    expect(symbol).toHaveTextContent("$");
    expect(name).toHaveTextContent("🇺🇸");
    expect(name).toHaveTextContent("US Dollar");
    expect(countryCode).toHaveTextContent("US");
    expect(currencyCode).toHaveTextContent("USD");
    expect(currencyCode).toHaveClass("tabular-nums", "text-end");

    await user.click(option);

    await waitFor(() => expect(updateDisplayCurrency).toHaveBeenCalledWith("USD"));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  });

  it("keeps an operator-report selection in its GET-form hidden input", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ReportFilterCombobox
        name="country"
        value="all"
        options={[
          { value: "all", label: "All" },
          { value: "KW", label: "Kuwait" },
        ]}
        label="Country"
        placeholder="All countries"
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Country" }));
    await user.type(screen.getByPlaceholderText("Search country…"), "Kuwait");
    await user.click(screen.getByRole("option", { name: "Kuwait" }));

    expect(screen.getByRole("combobox", { name: "Country" })).toHaveTextContent("Kuwait");
    expect(container.querySelector('input[name="country"]')).toHaveValue("KW");
  });
});
