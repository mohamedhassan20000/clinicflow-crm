import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const cookieSet = vi.fn();
const upsert = vi.fn();
const from = vi.fn(() => ({ upsert }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser }, from })),
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: cookieSet })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("setTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "platform-admin-without-profile" } }, error: null });
    upsert.mockResolvedValue({ error: null });
  });

  it("allows any authenticated user without requiring a clinic profile or subscription", async () => {
    const { setTheme } = await import("@/actions/theme");
    await setTheme("dark");
    expect(getUser).toHaveBeenCalledOnce();
    expect(cookieSet).toHaveBeenCalledWith("theme", "dark", expect.objectContaining({ path: "/", sameSite: "lax" }));
  });

  it("persists the theme to the user's own preference row — P2A (§4.5)", async () => {
    // Theme now follows the user, not the browser. The row is the source of truth and the cookie is
    // only a pre-render hint. It is keyed on the auth user id, which is what lets a platform admin
    // (who has no `profiles` row) hold a theme at all.
    const { setTheme } = await import("@/actions/theme");
    await setTheme("dark");

    expect(from).toHaveBeenCalledWith("user_ui_preferences");
    expect(upsert).toHaveBeenCalledWith(
      { user_id: "platform-admin-without-profile", theme: "dark" },
      { onConflict: "user_id" },
    );
  });

  it("does not disturb the stored locale when the theme changes", async () => {
    const { setTheme } = await import("@/actions/theme");
    await setTheme("light");

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0][0]).not.toHaveProperty("locale");
  });

  it("rejects an unauthenticated preference mutation", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    const { setTheme } = await import("@/actions/theme");
    await expect(setTheme("light")).rejects.toThrow("Authentication required");
    expect(cookieSet).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("leaves no stale cookie hint behind if the row write is rejected", async () => {
    upsert.mockResolvedValue({ error: { message: "row level security" } });
    const { setTheme } = await import("@/actions/theme");

    await expect(setTheme("dark")).rejects.toThrow("Could not save your theme.");
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
