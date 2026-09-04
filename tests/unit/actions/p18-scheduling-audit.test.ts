import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P18 — scheduling is the one administrative family audited from the
 * application boundary rather than by a trigger, because clinic hours are saved
 * as a delete-everything-then-insert replace (see the migration's header). These
 * tests hold that boundary to the same two promises the triggers make: exactly
 * one event per real change, and nothing at all for a save that changed nothing.
 */

const record = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => true),
);
const state = vi.hoisted(() => ({ existing: [] as unknown[] }));

vi.mock("@/lib/audit/record", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit/record")>();
  return { ...actual, recordAdminAuditEvent: record };
});

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

function selectBuilder() {
  const chain: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(chain, {
    get(_target, property: string) {
      if (property === "then") {
        return (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          resolve({ data: state.existing, error: null });
      }
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      select: () => selectBuilder(),
      delete: () => ({ eq: async () => ({ error: null }) }),
      insert: async () => ({ error: null }),
    }),
  })),
}));

const { upsertClinicWorkingHoursMutation } = await import("@/lib/settings/mutations");

const user = {
  id: "u1",
  clinicId: "c1",
  role: "admin" as const,
  email: "a@b.com",
  fullName: "Admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

const monday = (shifts: { shift_start: string; shift_end: string }[]) => [
  { day_of_week: 1, open: shifts.length > 0, shifts },
];

beforeEach(() => {
  record.mockClear();
  state.existing = [];
});

describe("clinic working hours", () => {
  it("records one event with the whole before → after shift set", async () => {
    state.existing = [
      { day_of_week: 1, shift_start: "09:00:00", shift_end: "13:00:00" },
    ];

    const result = await upsertClinicWorkingHoursMutation(user, {
      days: monday([{ shift_start: "10:00", shift_end: "14:00" }]),
    });
    expect(result.ok).toBe(true);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      module: "scheduling",
      action: "clinic_hours.updated",
      entityType: "clinic_hours",
      entityId: "c1",
      entityRef: null,
      before: { shift_count: 1, shifts: ["1:09:00-13:00"] },
      after: { shift_count: 1, shifts: ["1:10:00-14:00"] },
      changedFields: ["shifts"],
      metadata: undefined,
    });
  });

  it("records nothing when the same hours are saved again", async () => {
    state.existing = [
      { day_of_week: 1, shift_start: "09:00:00", shift_end: "13:00:00" },
    ];
    const result = await upsertClinicWorkingHoursMutation(user, {
      days: monday([{ shift_start: "09:00", shift_end: "13:00" }]),
    });
    expect(result.ok).toBe(true);
    expect(record).not.toHaveBeenCalled();
  });

  it("records closing the clinic as an emptied shift set, not as silence", async () => {
    state.existing = [
      { day_of_week: 1, shift_start: "09:00:00", shift_end: "13:00:00" },
    ];
    await upsertClinicWorkingHoursMutation(user, { days: monday([]) });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      after: { shift_count: 0, shifts: [] },
    });
  });

  it("never reaches the audit trail when the save itself was rejected", async () => {
    const result = await upsertClinicWorkingHoursMutation(user, { days: "not-a-schedule" });
    expect(result.ok).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});
