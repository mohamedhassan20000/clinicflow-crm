import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/clinic",
}));

import { SettingsPageHeader } from "@/components/settings/settings-page-header";

describe("SettingsPageHeader", () => {
  it("announces the current nested settings page without changing its role gate", () => {
    render(<SettingsPageHeader />);

    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(breadcrumb).getByText("Settings")).toBeInTheDocument();
    expect(within(breadcrumb).getByText("Clinic")).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/dashboard");
  });
});
