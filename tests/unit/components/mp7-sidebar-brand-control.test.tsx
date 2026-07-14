import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/layout/sidebar";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next/image", () => ({
  default: ({ alt = "", priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    void priority;
    // eslint-disable-next-line @next/next/no-img-element -- test-only Next Image mock
    return <img alt={alt} {...props} />;
  },
}));

const items = [{ href: "/dashboard", label: "Dashboard", icon: "dashboard" }] as const;

function CollapsibleSidebar() {
  const [collapsed, setCollapsed] = useState(false);
  return <Sidebar items={items} collapsed={collapsed} onCollapsedChange={setCollapsed} />;
}

describe("MP7 sidebar brand control", () => {
  it("uses the full desktop brand row as the only native collapse control", async () => {
    const user = userEvent.setup();
    render(<CollapsibleSidebar />);

    const collapse = screen.getByRole("button", { name: "Collapse navigation" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse).toHaveAttribute("aria-controls", "dashboard-navigation");
    expect(collapse).toHaveAttribute("title", "Collapse navigation");
    expect(collapse).toContainElement(screen.getByAltText("ClinicFlow"));
    expect(collapse.closest("[data-testid='sidebar-brand-row']")).not.toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /ClinicFlow/i })).not.toBeInTheDocument();

    collapse.focus();
    await user.keyboard("{Enter}");
    const expand = screen.getByRole("button", { name: "Expand navigation" });
    expect(expand).toHaveFocus();
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expect(expand).toHaveAttribute("title", "Expand navigation");

    await user.keyboard(" ");
    expect(screen.getByRole("button", { name: "Collapse navigation" })).toHaveFocus();
  });

  it("keeps the mobile-sheet brand row non-interactive", () => {
    render(<Sidebar mode="sheet" items={items} collapsed={false} onCollapsedChange={vi.fn()} />);

    const sheet = screen.getByTestId("mobile-sidebar");
    expect(sheet.querySelector("[aria-expanded]")).toBeNull();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /ClinicFlow/i })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "ClinicFlow navigation" })).toHaveAttribute("id", "mobile-navigation");
  });
});
