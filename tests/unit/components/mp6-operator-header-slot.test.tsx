import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const clinicItems = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/patients", label: "Patients", icon: "patients" },
] as const;

const operatorItems = [{ href: "/operator", label: "Mission Control", icon: "dashboard" }] as const;

async function openUserMenu() {
  await userEvent.click(screen.getByRole("button", { name: "Open user menu" }));
  await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
}

describe("MP6 — dashboard shell audience", () => {
  beforeEach(() => localStorage.clear());

  it("omits Preferences on the operator surface and leaves the reserved slot empty", async () => {
    render(
      <DashboardShell
        navItems={operatorItems}
        user={{ fullName: "owner@clinicflow.fit", email: "owner@clinicflow.fit", roleLabel: "Platform admin" }}
        theme="light"
        surface="operator"
        brandLabel="ClinicFlow Operator"
      >
        Content
      </DashboardShell>,
    );

    // The operator keeps its own theme toggle (§6.C) — asserted before the menu opens, since the
    // dropdown makes the rest of the page inert.
    expect(screen.getByRole("button", { name: "Switch to dark mode" })).toBeInTheDocument();

    await openUserMenu();

    expect(screen.queryByRole("menuitem", { name: /preferences/i })).not.toBeInTheDocument();
    expect(document.body.querySelector('a[href="/preferences"]')).toBeNull();

    // The reserved slot is reserved, not stubbed: no language control of any kind ships before P2.
    expect(screen.queryByRole("menuitem", { name: /language/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /language/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /language/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/language|english|عرب/i);

    // The rest of the user menu is untouched.
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toBeInTheDocument();
  });

  it("keeps Preferences on the clinic surface for every clinic role", async () => {
    for (const roleLabel of ["owner", "admin", "doctor", "receptionist", "nurse"]) {
      const { unmount } = render(
        <DashboardShell
          navItems={clinicItems}
          user={{ fullName: `${roleLabel} user`, email: `${roleLabel}@clinic.test`, roleLabel, profileHref: "/profile" }}
          theme="light"
          surface="clinic"
        >
          Content
        </DashboardShell>,
      );

      await openUserMenu();

      const preferences = screen.getByRole("menuitem", { name: /preferences/i });
      expect(preferences).toBeInTheDocument();
      expect(preferences).toHaveAttribute("href", "/preferences");
      expect(screen.queryByRole("button", { name: /language/i })).not.toBeInTheDocument();

      unmount();
    }
  });
});
