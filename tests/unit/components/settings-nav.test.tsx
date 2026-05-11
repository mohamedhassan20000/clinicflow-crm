import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsNav } from "@/components/settings/settings-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/staff",
}));

describe("SettingsNav customize visibility", () => {
  it("hides Customize when the current role cannot customize settings", () => {
    render(<SettingsNav canCustomize={false} />);

    expect(screen.queryByRole("link", { name: "Customize" })).not.toBeInTheDocument();
  });

  it("shows Customize for authorized admins", () => {
    render(<SettingsNav canCustomize />);

    expect(screen.getByRole("link", { name: "Customize" })).toHaveAttribute(
      "href",
      "/settings/customize",
    );
  });

  it("blocks manager direct access at the customize page boundary", () => {
    const pageSource = readFileSync(
      "app/(protected)/settings/customize/page.tsx",
      "utf8",
    );
    const actionSource = readFileSync("actions/page-permissions.ts", "utf8");

    expect(pageSource).toContain('requireRole("admin")');
    expect(pageSource).not.toContain('requireRole(["admin", "manager"])');
    expect(actionSource).toContain('requireRole("admin")');
    expect(actionSource).not.toContain('requireRole(["admin", "manager"])');
  });
});
