import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";

/**
 * Phase 5f F1 fallout — found by the browser E2E, not by any mocked test.
 *
 * `verifyCurrentPasswordStepUp` signs in on a throwaway client to check the
 * admin's password. supabase-js defaults `signOut()` to `scope: "global"`,
 * which asks GoTrue to revoke *every* session for that user — so verifying the
 * password destroyed the browser session that was mid-confirmation and bounced
 * the admin to /login before the privileged action could report back. The
 * mutation still committed; the actor just never saw it.
 */

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    mocks.createClient(...args);
    return {
      auth: {
        signInWithPassword: mocks.signInWithPassword,
        signOut: mocks.signOut,
      },
    };
  },
}));

import { verifyCurrentPasswordStepUp } from "@/lib/auth/step-up";

const USER: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "owner@example.com",
  fullName: "Clinic Owner",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
  mocks.signOut.mockResolvedValue({ error: null });
});

describe("privileged step-up never revokes the caller's own session", () => {
  it("cleans up the throwaway session with scope 'local', never a global sign-out", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: { id: USER.id } },
      error: null,
    });

    await expect(verifyCurrentPasswordStepUp(USER, "correct-password")).resolves.toBe(
      true,
    );
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    // A bare `signOut()` (or an explicit "global"/"others") revokes the browser
    // session too. Both are regressions of the same bug.
    expect(mocks.signOut).not.toHaveBeenCalledWith();
    expect(mocks.signOut).not.toHaveBeenCalledWith({ scope: "global" });
    expect(mocks.signOut).not.toHaveBeenCalledWith({ scope: "others" });
  });

  it("does not sign out at all when the credential was wrong", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: { message: "Invalid login credentials" },
    });

    await expect(verifyCurrentPasswordStepUp(USER, "wrong")).resolves.toBe(false);
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("refuses when the verified identity is not the acting user", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: { id: "00000000-0000-4000-8000-00000000000f" } },
      error: null,
    });

    await expect(verifyCurrentPasswordStepUp(USER, "someone-elses")).resolves.toBe(
      false,
    );
  });
});
