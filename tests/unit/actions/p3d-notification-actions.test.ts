import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireMutationUser: vi.fn(),
  revalidatePath: vi.fn(),
  state: {
    updates: [] as Array<{ table: string; payload: unknown; filters: unknown[] }>,
    updateError: null as unknown,
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: (key: string) => Promise.resolve(key),
}));
vi.mock("@/lib/rbac", () => ({
  requireMutationUser: mocks.requireMutationUser,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: () => ({
    from: (table: string) => {
      const filters: unknown[] = [];
      const chain = {
        update: (payload: unknown) => {
          mocks.state.updates.push({ table, payload, filters });
          return chain;
        },
        eq: (...args: unknown[]) => {
          filters.push(["eq", ...args]);
          return chain;
        },
        is: (...args: unknown[]) => {
          filters.push(["is", ...args]);
          return chain;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: null, error: mocks.state.updateError }).then(resolve),
      };
      return chain;
    },
  }),
}));

import {
  markAllNotificationsRead,
  markNotificationRead,
} from "@/actions/notifications";

const notificationId = "77777777-7777-4777-8777-777777777777";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.updates = [];
  mocks.state.updateError = null;
  mocks.requireMutationUser.mockResolvedValue({
    id: "user-1",
    clinicId: "clinic-1",
    role: "doctor",
  });
});

describe("markNotificationRead", () => {
  it("marks only the caller's own unread row", async () => {
    const result = await markNotificationRead(notificationId);
    expect(result).toEqual({ success: true });
    const update = mocks.state.updates[0];
    expect(update.table).toBe("notifications");
    expect(update.payload).toMatchObject({ read_at: expect.any(String) });
    expect(update.filters).toEqual(
      expect.arrayContaining([
        ["eq", "id", notificationId],
        ["eq", "recipient_id", "user-1"],
        ["is", "read_at", null],
      ]),
    );
  });

  it("rejects a malformed id without writing", async () => {
    const result = await markNotificationRead("not-a-uuid");
    expect(result.error).toBe("notifications.couldNotUpdateNotifications");
    expect(mocks.state.updates).toHaveLength(0);
  });

  it("surfaces a write failure", async () => {
    mocks.state.updateError = { message: "boom" };
    const result = await markNotificationRead(notificationId);
    expect(result.error).toBe("notifications.couldNotUpdateNotifications");
  });
});

describe("markAllNotificationsRead", () => {
  it("marks every unread row belonging to the caller only", async () => {
    const result = await markAllNotificationsRead();
    expect(result).toEqual({ success: true });
    const update = mocks.state.updates[0];
    expect(update.filters).toEqual(
      expect.arrayContaining([
        ["eq", "recipient_id", "user-1"],
        ["is", "read_at", null],
      ]),
    );
  });
});
