import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const AVATAR_URL =
  "https://example.supabase.co/storage/v1/object/public/avatars/user-1/avatar-old.webp";

async function loadProfileActions() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
  }));
  vi.doMock("@/lib/rbac", () => ({
    requireUser: vi.fn(async () => mocks.state.authedUser),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));

  const actions = await import("@/actions/profile");
  return { ...actions, mocks };
}

describe("profile avatar removal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the current user's avatar URL and removes the storage object", async () => {
    const { removeAvatar, mocks } = await loadProfileActions();
    mocks.state.tableResults["profiles.select"] = {
      data: { avatar_url: AVATAR_URL },
      error: null,
    };
    mocks.state.tableResults["profiles.update"] = {
      data: null,
      error: null,
    };

    const result = await removeAvatar(null);

    expect(result).toEqual({ ok: true });
    expect(mocks.state.queryLog).toContainEqual(
      expect.objectContaining({
        table: "profiles",
        operation: "update",
        args: [expect.objectContaining({ avatar_url: null })],
      }),
    );
    expect(mocks.state.storageRemove).toHaveBeenCalledWith([
      "user-1/avatar-old.webp",
    ]);
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/profile");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(mocks.state.revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("still succeeds when storage removal fails after the avatar field is cleared", async () => {
    const { removeAvatar, mocks } = await loadProfileActions();
    mocks.state.tableResults["profiles.select"] = {
      data: { avatar_url: AVATAR_URL },
      error: null,
    };
    mocks.state.tableResults["profiles.update"] = {
      data: null,
      error: null,
    };
    mocks.state.storageRemove.mockResolvedValue({
      data: null,
      error: { message: "storage unavailable" },
    });

    const result = await removeAvatar(null);

    expect(result).toEqual({ ok: true });
    expect(mocks.state.storageRemove).toHaveBeenCalledWith([
      "user-1/avatar-old.webp",
    ]);
  });

  it("does not remove storage when clearing the DB avatar field fails", async () => {
    const { removeAvatar, mocks } = await loadProfileActions();
    mocks.state.tableResults["profiles.select"] = {
      data: { avatar_url: AVATAR_URL },
      error: null,
    };
    mocks.state.tableResults["profiles.update"] = {
      data: null,
      error: { message: "update failed" },
    };

    const result = await removeAvatar(null);

    expect(result).toEqual({ error: "update failed" });
    expect(mocks.state.storageRemove).not.toHaveBeenCalled();
  });
});
