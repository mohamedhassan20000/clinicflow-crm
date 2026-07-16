import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardShell } from "@/components/layout/dashboard-shell";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/image", () => ({
  default: ({ alt = "", priority, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { priority?: boolean }) => {
    void priority;
    // eslint-disable-next-line @next/next/no-img-element -- test-only Next Image mock
    return <img alt={alt} {...props} />;
  },
}));
vi.mock("@/actions/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/actions/theme", () => ({ setTheme: vi.fn() }));

const items = [
  { href: "/dashboard", labelKey: "tenant.dashboard", icon: "dashboard" },
  { href: "/patients", labelKey: "tenant.patients", icon: "patients" },
] as const;

describe("DashboardShell", () => {
  beforeEach(() => localStorage.clear());

  it("renders the header utilities and expanded navigation", () => {
    const { container } = render(<DashboardShell navItems={items} user={{ fullName: "Ada Admin", roleLabel: "admin", profileHref: "/profile" }} theme="light" surface="clinic"><h1>Content</h1></DashboardShell>);
    expect(screen.getByTestId("dashboard-header")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open user menu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse navigation" })).toHaveAttribute("aria-controls", "dashboard-navigation");
    expect(screen.getByRole("button", { name: "Collapse navigation" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: /Patients/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
    expect(container.querySelector("main")).toHaveAttribute("id", "main-content");
    expect(container.querySelector("main")).toHaveAttribute("tabindex", "-1");
    expect(container).toMatchSnapshot();
  });

  it("persists, snapshots, and restores collapsed state", async () => {
    const { container, unmount } = render(<DashboardShell navItems={items} user={{ fullName: "Ada Admin", roleLabel: "admin" }} theme="light" surface="clinic">Content</DashboardShell>);
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(localStorage.getItem("clinicflow:sidebar-collapsed")).toBe("true");
    expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand navigation" })).toHaveAttribute("aria-expanded", "false");
    expect(container).toMatchSnapshot();
    unmount();
    render(<DashboardShell navItems={items} user={{ fullName: "Ada Admin", roleLabel: "admin" }} theme="light" surface="clinic">Content</DashboardShell>);
    await waitFor(() => expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-collapsed", "true"));
  });

  it("only renders navigation entries supplied by the visibility model", () => {
    render(<DashboardShell navItems={[items[0]]} user={{ fullName: "Doc User", roleLabel: "doctor" }} theme="dark" surface="clinic">Content</DashboardShell>);
    expect(screen.getByRole("link", { name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Patients/ })).not.toBeInTheDocument();
  });

  it("migrates the legacy collapse preference once", async () => {
    localStorage.setItem("sidebar-collapsed", "true");
    render(<DashboardShell navItems={items} user={{ fullName: "Ada Admin", roleLabel: "admin" }} theme="light" surface="clinic">Content</DashboardShell>);
    await waitFor(() => expect(screen.getByTestId("dashboard-sidebar")).toHaveAttribute("data-collapsed", "true"));
    expect(localStorage.getItem("clinicflow:sidebar-collapsed")).toBe("true");
    expect(localStorage.getItem("sidebar-collapsed")).toBeNull();
  });
});
