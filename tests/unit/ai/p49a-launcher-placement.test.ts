import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  from: vi.fn(),
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  results: {
    assistant_launcher_settings: { data: null, error: null } as {
      data: { enabled: boolean } | null;
      error: unknown;
    },
    assistant_launcher_user_overrides: { data: null, error: null } as {
      data: { enabled: boolean } | null;
      error: unknown;
    },
  },
}));

vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({ from: mocks.from }),
}));

import {
  resolveAssistantLauncherPlacement,
  resolveAssistantLauncherPlacementValue,
} from "@/lib/ai/launcher-placement";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "doctor@example.com",
  role: "doctor" as const,
  fullName: "Doctor",
  avatarUrl: null,
  departmentId: "00000000-0000-4000-8000-000000000003",
  mustChangePassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.results.assistant_launcher_settings = { data: null, error: null };
  mocks.results.assistant_launcher_user_overrides = { data: null, error: null };
  mocks.getEntitlements.mockResolvedValue({ planSlug: "pro_ai" });
  mocks.hasFeature.mockReturnValue(true);
  mocks.from.mockImplementation((table: keyof typeof mocks.results) => {
    const query = { table, filters: [] as Array<[string, unknown]> };
    mocks.queries.push(query);
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn((column: string, value: unknown) => {
        query.filters.push([column, value]);
        return builder;
      }),
      maybeSingle: vi.fn(async () => mocks.results[table]),
    };
    return builder;
  });
});

describe("P4.9A launcher placement precedence", () => {
  it("uses only the code default when customization is not entitled", () => {
    expect(resolveAssistantLauncherPlacementValue({
      customizationEntitled: false,
      defaultEnabled: true,
      roleSetting: false,
      userOverride: false,
    })).toBe(true);
  });

  it.each([
    [{ defaultEnabled: true }, true],
    [{ defaultEnabled: false }, false],
    [{ defaultEnabled: true, roleSetting: false }, false],
    [{ defaultEnabled: false, roleSetting: true }, true],
    [{ defaultEnabled: true, roleSetting: true, userOverride: false }, false],
    [{ defaultEnabled: false, roleSetting: false, userOverride: true }, true],
  ] as const)("applies default, role, then user precedence for %o", (overrides, expected) => {
    expect(resolveAssistantLauncherPlacementValue({
      customizationEntitled: true,
      ...overrides,
    })).toBe(expected);
  });

  it("does not read placement tables for Basic, Professional, or a disabled override", async () => {
    mocks.hasFeature.mockReturnValue(false);

    await expect(resolveAssistantLauncherPlacement({
      user: USER,
      area: "patient",
      defaultEnabled: true,
    })).resolves.toBe(true);

    expect(mocks.hasFeature).toHaveBeenCalledWith(
      { planSlug: "pro_ai" },
      "ai.assistant_customization",
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("resolves tenant, role, and user rows and lets the user override win", async () => {
    mocks.results.assistant_launcher_settings.data = { enabled: false };
    mocks.results.assistant_launcher_user_overrides.data = { enabled: true };

    await expect(resolveAssistantLauncherPlacement({
      user: USER,
      area: "patient",
      defaultEnabled: true,
    })).resolves.toBe(true);

    expect(mocks.queries).toEqual([
      {
        table: "assistant_launcher_settings",
        filters: [
          ["clinic_id", USER.clinicId],
          ["area", "patient"],
          ["role", "doctor"],
        ],
      },
      {
        table: "assistant_launcher_user_overrides",
        filters: [
          ["clinic_id", USER.clinicId],
          ["user_id", USER.id],
          ["area", "patient"],
        ],
      },
    ]);
  });

  it("fails closed at the launcher boundary when either persisted lookup fails", async () => {
    mocks.results.assistant_launcher_user_overrides.error = { code: "PGRST205" };

    await expect(resolveAssistantLauncherPlacement({
      user: USER,
      area: "patient",
      defaultEnabled: true,
    })).rejects.toThrow("Failed to resolve Assistant launcher placement");
  });
});

describe("P4.9 phase boundary", () => {
  it("adds the P4.9B settings surface without starting P4.10", () => {
    expect(existsSync("app/(protected)/settings/assistant/page.tsx")).toBe(true);
    expect(existsSync("actions/assistant-launcher-settings.ts")).toBe(true);
    expect(existsSync("supabase/migrations/20260722140000_p410_conversation_context.sql"))
      .toBe(false);
  });
});
