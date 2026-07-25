import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  primary: true,
  entitled: true,
  requireRole: vi.fn(),
  isPrimaryClinicAdmin: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  getCustomization: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/rbac", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/primary-admin", () => ({
  isPrimaryClinicAdmin: mocks.isPrimaryClinicAdmin,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/ai/launcher-customization", () => ({
  getAssistantLauncherCustomization: mocks.getCustomization,
}));
vi.mock("@/components/settings/assistant-launcher-customizer", () => ({
  AssistantLauncherCustomizer: () => (
    <div data-testid="assistant-launcher-customizer" />
  ),
}));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

import AssistantCustomizationPage from "@/app/(protected)/settings/assistant/page";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "owner@clinic.test",
  role: "admin" as const,
  fullName: "Owner",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.primary = true;
  mocks.entitled = true;
  mocks.requireRole.mockResolvedValue(USER);
  mocks.isPrimaryClinicAdmin.mockImplementation(async () => mocks.primary);
  mocks.getEntitlements.mockResolvedValue({ planSlug: "pro_ai" });
  mocks.hasFeature.mockImplementation(() => mocks.entitled);
  mocks.getCustomization.mockResolvedValue({ roleSettings: [], staff: [] });
  mocks.redirect.mockImplementation((href: string) => {
    throw new Error(`redirect:${href}`);
  });
});

describe("P4.9B Assistant customization page", () => {
  it("renders the primary-admin editor only when customization is entitled", async () => {
    render(await AssistantCustomizationPage());

    expect(mocks.requireRole).toHaveBeenCalledWith("admin");
    expect(mocks.hasFeature).toHaveBeenCalledWith(
      { planSlug: "pro_ai" },
      "ai.assistant_customization",
    );
    expect(screen.getByTestId("assistant-launcher-customizer")).toBeVisible();
  });

  it("shows a non-mutating upgrade gate on Basic and Professional plans", async () => {
    mocks.entitled = false;
    render(await AssistantCustomizationPage());

    expect(screen.getByRole("heading", {
      name: "Assistant customization is available on Pro + AI",
    })).toBeVisible();
    expect(screen.getByText(/product defaults are unchanged/i)).toBeVisible();
    expect(mocks.getCustomization).not.toHaveBeenCalled();
  });

  it("denies secondary admins before loading any placement rows", async () => {
    mocks.primary = false;

    await expect(AssistantCustomizationPage()).rejects.toThrow(
      "redirect:/dashboard",
    );
    expect(mocks.getCustomization).not.toHaveBeenCalled();
  });

  it("fails soft with a localized alert when placement metadata cannot load", async () => {
    mocks.getCustomization.mockRejectedValue(new Error("database unavailable"));
    render(await AssistantCustomizationPage());

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Assistant placement settings could not be loaded",
    );
    expect(screen.queryByTestId("assistant-launcher-customizer")).not.toBeInTheDocument();
  });
});
