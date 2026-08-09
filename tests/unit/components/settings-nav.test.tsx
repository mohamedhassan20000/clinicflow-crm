import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsNav } from "@/components/settings/settings-nav";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/staff",
}));

describe("SettingsNav customize visibility", () => {
  it("hides Customize when the current role cannot customize settings", () => {
    render(<SettingsNav canCustomize={false} canManageAi={false} />);

    expect(screen.queryByRole("link", { name: "Customize" })).not.toBeInTheDocument();
  });

  it("shows Customize for authorized admins", () => {
    render(<SettingsNav canCustomize canManageAi />);

    expect(screen.getByRole("link", { name: "Customize" })).toHaveAttribute(
      "href",
      "/settings/customize",
    );
    expect(screen.getByRole("link", { name: "Assistant placement" })).toHaveAttribute(
      "href",
      "/settings/assistant",
    );
  });

  it("keeps the Assistant placement upgrade gate available to primary admins without AI", () => {
    render(<SettingsNav canCustomize canManageAi={false} />);

    expect(screen.getByRole("link", { name: "Assistant placement" })).toHaveAttribute(
      "href",
      "/settings/assistant",
    );
    expect(screen.queryByRole("link", { name: "AI provider" })).not.toBeInTheDocument();
  });

  it("shows the P3B messaging settings entry to both settings roles", () => {
    render(<SettingsNav canCustomize={false} canManageAi={false} />);
    expect(screen.getByRole("link", { name: "Messaging" })).toHaveAttribute(
      "href",
      "/settings/messaging",
    );
  });

  it("shows Documents settings only to the primary admin (canCustomize)", () => {
    const { rerender } = render(
      <SettingsNav canCustomize={false} canManageAi={false} />,
    );
    expect(screen.queryByRole("link", { name: "Documents" })).not.toBeInTheDocument();

    rerender(<SettingsNav canCustomize canManageAi={false} />);
    expect(screen.getByRole("link", { name: "Documents" })).toHaveAttribute(
      "href",
      "/settings/documents",
    );
  });

  it("gates the documents settings page at the primary-admin boundary", () => {
    const pageSource = readFileSync(
      "app/(protected)/settings/documents/page.tsx",
      "utf8",
    );
    const actionSource = readFileSync("actions/documents-settings.ts", "utf8");
    expect(pageSource).toContain('requireRole("admin")');
    expect(pageSource).toContain("isPrimaryClinicAdmin");
    expect(actionSource).toContain("isPrimaryClinicAdmin");
  });

  it("shows AI provider settings only when the server grants provider management", () => {
    const { rerender } = render(
      <SettingsNav canCustomize canManageAi={false} />,
    );
    expect(screen.queryByRole("link", { name: "AI provider" })).not.toBeInTheDocument();

    rerender(<SettingsNav canCustomize canManageAi />);
    expect(screen.getByRole("link", { name: "AI provider" })).toHaveAttribute(
      "href",
      "/settings/ai",
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
