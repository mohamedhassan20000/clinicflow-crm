import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const updateOwnLocale = vi.fn<(locale: string) => Promise<void>>(async () => {});
const setMarketingLocale = vi.fn<(locale: string) => Promise<void>>(async () => {});
const refresh = vi.fn();
const replace = vi.fn();

vi.mock("@/actions/locale", () => ({
  updateOwnLocale: (locale: string) => updateOwnLocale(locale),
  setMarketingLocale: (locale: string) => setMarketingLocale(locale),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, replace }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { LanguageSwitcher } from "@/components/i18n/language-switcher";

const labels = {
  selectLabel: "Select language",
  updated: "Language updated",
  updateFailed: "Could not change the language.",
};

beforeEach(() => {
  updateOwnLocale.mockClear();
  setMarketingLocale.mockClear();
  refresh.mockClear();
  replace.mockClear();
});

describe("P2A language switcher (§6.A)", () => {
  it("offers exactly English and Arabic, in their own scripts", async () => {
    render(<LanguageSwitcher locale="en" scope="account" labels={labels} />);

    await userEvent.click(screen.getByRole("combobox"));

    expect(screen.getByRole("option", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "العربية" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("writes the account's own preference on the account scope — Preferences and the operator header", async () => {
    render(<LanguageSwitcher locale="en" scope="account" labels={labels} />);

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "العربية" }));

    expect(updateOwnLocale).toHaveBeenCalledWith("ar");
    expect(setMarketingLocale).not.toHaveBeenCalled();
    // Runtime switch: the tree re-renders, no sign-out and no full reload.
    expect(refresh).toHaveBeenCalled();
  });

  it("writes only the anonymous cookie on the marketing scope — it touches no account", async () => {
    render(<LanguageSwitcher locale="en" scope="marketing" labels={labels} />);

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "العربية" }));

    expect(setMarketingLocale).toHaveBeenCalledWith("ar");
    expect(updateOwnLocale).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith("/?landingLocale=ar", { scroll: false });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reflects the active locale and does not re-write it when reselected", async () => {
    render(<LanguageSwitcher locale="ar" scope="account" labels={labels} />);

    expect(screen.getByRole("combobox")).toHaveTextContent("العربية");

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: "العربية" }));

    expect(updateOwnLocale).not.toHaveBeenCalled();
  });

  it("is a real control, not a placeholder — it is enabled and labelled", () => {
    render(<LanguageSwitcher locale="en" scope="account" labels={labels} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveAccessibleName("Select language");
  });
});
