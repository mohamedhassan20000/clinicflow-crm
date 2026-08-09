import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P7-10 — clinical-record lifecycle immutability. Once a clinical record is
 * finalized (locked and rendered into an issued document snapshot), it may only
 * move forward to `void`; a finalized record can never be re-finalized or edited
 * back into a draft (doc 16 §2, §12 Q2). These unit tests pin the status-transition
 * guards in `actions/clinical/_shared.ts` — the `.eq("status", …)` filters that make
 * the transitions single-directional and the `recordLocked` result when no row in
 * the expected state is found — without needing a live database.
 */

type QueryLog = {
  table: string;
  operation: "select" | "insert" | "update" | "delete";
  payload?: Record<string, unknown>;
  filters: Array<[string, unknown]>;
};

const mocks = vi.hoisted(() => ({
  user: {
    id: "22222222-2222-4222-8222-222222222222",
    clinicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "prep@clinic.test",
    role: "receptionist" as const,
    fullName: "Preparer",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  },
  matchedRow: null as { id: string } | null,
  updateError: null as unknown,
  logs: [] as QueryLog[],
}));

function builder(table: string) {
  const entry: QueryLog = { table, operation: "select", filters: [] };
  mocks.logs.push(entry);
  const query = {
    update: vi.fn((payload: Record<string, unknown>) => {
      entry.operation = "update";
      entry.payload = payload;
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      entry.filters.push([column, value]);
      return query;
    }),
    select: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: mocks.matchedRow, error: mocks.updateError })),
  };
  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: (table: string) => builder(table) })),
}));
vi.mock("@/lib/rbac", () => ({
  requireMutationRole: vi.fn(async () => mocks.user),
  requireRole: vi.fn(async () => mocks.user),
}));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: vi.fn(async (key: string) => key),
}));

import { finalizeClinicalRecord, voidClinicalRecord } from "@/actions/clinical/_shared";

function lastUpdate() {
  return [...mocks.logs].reverse().find((log) => log.operation === "update");
}

describe("P7-10 clinical-record lifecycle immutability", () => {
  beforeEach(() => {
    mocks.logs = [];
    mocks.matchedRow = null;
    mocks.updateError = null;
  });

  it("finalize transitions only a draft, scoped to the caller's clinic", async () => {
    mocks.matchedRow = { id: "rx-1" };
    const result = await finalizeClinicalRecord("prescriptions", "rx-1");

    expect(result).toEqual({ success: true, data: { id: "rx-1", status: "finalized" } });
    const update = lastUpdate();
    expect(update?.table).toBe("prescriptions");
    expect(update?.payload).toMatchObject({ status: "finalized", finalized_by: mocks.user.id });
    // Draft-only + own-clinic + target-id guard.
    expect(update?.filters).toContainEqual(["status", "draft"]);
    expect(update?.filters).toContainEqual(["clinic_id", mocks.user.clinicId]);
    expect(update?.filters).toContainEqual(["id", "rx-1"]);
  });

  it("refuses to re-finalize a non-draft record (returns recordLocked, writes nothing new)", async () => {
    mocks.matchedRow = null; // already finalized/void ⇒ no draft row matches
    const result = await finalizeClinicalRecord("lab_requests", "lab-9");

    expect(result.success).toBeUndefined();
    expect(result.error).toBe("clinical.recordLocked");
    // The guarded update still filtered on status=draft — it simply matched nothing.
    expect(lastUpdate()?.filters).toContainEqual(["status", "draft"]);
  });

  it("void transitions only a finalized record forward, never a draft", async () => {
    mocks.matchedRow = { id: "sl-3" };
    const result = await voidClinicalRecord("sick_leaves", "sl-3");

    expect(result).toEqual({ success: true, data: { id: "sl-3", status: "void" } });
    const update = lastUpdate();
    expect(update?.payload).toMatchObject({ status: "void" });
    expect(update?.filters).toContainEqual(["status", "finalized"]);
    expect(update?.filters).toContainEqual(["clinic_id", mocks.user.clinicId]);
  });

  it("refuses to void anything that is not finalized (returns recordLocked)", async () => {
    mocks.matchedRow = null; // draft or already-void ⇒ no finalized row matches
    const result = await voidClinicalRecord("prescriptions", "rx-draft");

    expect(result.error).toBe("clinical.recordLocked");
    expect(lastUpdate()?.filters).toContainEqual(["status", "finalized"]);
  });

  it("surfaces a mutation failure distinctly from a locked record", async () => {
    mocks.updateError = new Error("db down");
    const result = await finalizeClinicalRecord("prescriptions", "rx-err");

    expect(result.error).toBe("clinical.mutationFailed");
  });
});
