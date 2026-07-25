import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantLauncherCustomizationData } from "@/lib/ai/launcher-customization-types";

const mocks = vi.hoisted(() => ({
  setRole: vi.fn(),
  setUser: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/actions/assistant-launcher-settings", () => ({
  setAssistantRoleLauncherPlacement: mocks.setRole,
  setAssistantUserLauncherOverride: mocks.setUser,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

import { AssistantLauncherCustomizer } from "@/components/settings/assistant-launcher-customizer";

const DATA: AssistantLauncherCustomizationData = {
  roleSettings: [
    {
      area: "patient",
      defaultEnabled: true,
      eligibleRoles: ["doctor"],
      roleSettings: {},
    },
    {
      area: "dashboard",
      defaultEnabled: true,
      eligibleRoles: ["admin", "manager", "receptionist", "doctor"],
      roleSettings: { manager: false },
    },
  ],
  staff: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      fullName: "Dr. Lina",
      role: "doctor",
      overrides: {},
    },
    {
      id: "33333333-3333-4333-8333-333333333333",
      fullName: "Mona Admin",
      role: "admin",
      overrides: { dashboard: false },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.dir = "ltr";
  mocks.setRole.mockResolvedValue({ success: true });
  mocks.setUser.mockResolvedValue({ success: true });
});

describe("P4.9B Assistant launcher placement UI", () => {
  it("renders an accessible area-by-role matrix without unsupported toggles", () => {
    render(<AssistantLauncherCustomizer initialData={DATA} />);

    expect(screen.getByRole("table", {
      name: "Assistant launcher placement by product area and role",
    })).toBeVisible();
    expect(screen.getByRole("switch", {
      name: "Show the Patient details Assistant launcher for Doctor",
    })).toBeChecked();
    expect(screen.queryByRole("switch", {
      name: "Show the Patient details Assistant launcher for Administrator",
    })).not.toBeInTheDocument();
    expect(screen.getByText("Placement changes visibility only")).toBeVisible();
  });

  it("supports keyboard toggling and persists one eligible role decision", async () => {
    const user = userEvent.setup();
    render(<AssistantLauncherCustomizer initialData={DATA} />);
    const toggle = screen.getByRole("switch", {
      name: "Show the Patient details Assistant launcher for Doctor",
    });

    toggle.focus();
    await user.keyboard(" ");

    await waitFor(() => {
      expect(mocks.setRole).toHaveBeenCalledWith({
        area: "patient",
        role: "doctor",
        enabled: false,
      });
    });
    expect(toggle).not.toBeChecked();
  });

  it("can reset an explicit role choice to the code-owned default", async () => {
    const user = userEvent.setup();
    render(<AssistantLauncherCustomizer initialData={DATA} />);

    await user.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => {
      expect(mocks.setRole).toHaveBeenCalledWith({
        area: "dashboard",
        role: "manager",
        enabled: null,
      });
    });
  });

  it("applies and resets a per-user override while preserving role inheritance", async () => {
    const user = userEvent.setup();
    render(<AssistantLauncherCustomizer initialData={DATA} />);

    await user.click(screen.getByRole("tab", { name: "People" }));
    const doctorToggle = screen.getByRole("switch", {
      name: "Show the Patient details Assistant launcher for Dr. Lina",
    });
    expect(doctorToggle).toBeChecked();
    expect(screen.getAllByText("Inherited: shown")).not.toHaveLength(0);

    await user.click(doctorToggle);
    await waitFor(() => {
      expect(mocks.setUser).toHaveBeenCalledWith({
        userId: "22222222-2222-4222-8222-222222222222",
        area: "patient",
        enabled: false,
      });
    });
    expect(screen.getByText("Personal override")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Use role setting" }));
    await waitFor(() => {
      expect(mocks.setUser).toHaveBeenLastCalledWith({
        userId: "22222222-2222-4222-8222-222222222222",
        area: "patient",
        enabled: null,
      });
    });
  });

  it("keeps the same keyboard-accessible controls in RTL", async () => {
    document.documentElement.dir = "rtl";
    const user = userEvent.setup();
    render(<AssistantLauncherCustomizer initialData={DATA} />);
    const toggle = screen.getByRole("switch", {
      name: "Show the Patient details Assistant launcher for Doctor",
    });

    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(mocks.setRole).toHaveBeenCalledTimes(1));
    expect(toggle).not.toBeChecked();
  });
});
