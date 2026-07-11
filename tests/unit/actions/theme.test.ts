import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const cookieSet = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser } })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: cookieSet })),
}));

describe("setTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "platform-admin-without-profile" } }, error: null });
  });

  it("allows any authenticated user without requiring a clinic profile or subscription", async () => {
    const { setTheme } = await import("@/actions/theme");
    await setTheme("dark");
    expect(getUser).toHaveBeenCalledOnce();
    expect(cookieSet).toHaveBeenCalledWith("theme", "dark", expect.objectContaining({ path: "/", sameSite: "lax" }));
  });

  it("rejects an unauthenticated preference mutation", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const { setTheme } = await import("@/actions/theme");
    await expect(setTheme("light")).rejects.toThrow("Authentication required");
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
