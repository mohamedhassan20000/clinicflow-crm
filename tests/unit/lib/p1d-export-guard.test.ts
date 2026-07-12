import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Role-gate coverage for the per-clinic data export: middleware admits
 * managers to /settings/*, so the route-level requireRole("admin") call is the
 * only barrier between non-admin staff and a full patient-database ZIP. The
 * mocked guard reproduces requireRole's real semantics (redirect-throw for a
 * disallowed role) against a settable session role.
 */

const state = vi.hoisted(() => ({
  role: "admin",
  fromCalls: [] as string[],
  requestedRoles: [] as unknown[],
}));

vi.mock("@/lib/rbac", () => ({
  requireRole: vi.fn(async (roles: string | string[]) => {
    state.requestedRoles.push(roles);
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(state.role)) {
      // Real requireRole calls next/navigation redirect(), which throws.
      throw new Error("NEXT_REDIRECT:/dashboard");
    }
    return { id: "admin-1", clinicId: "clinic-1", role: state.role };
  }),
}));

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order", "range"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => ({ data: {}, error: null }));
  // Short (empty) page terminates the export's pagination loop immediately.
  builder.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
  return builder as never;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      state.fromCalls.push(table);
      return makeBuilder();
    }),
    storage: {
      from: vi.fn(() => ({
        createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
      })),
    },
  })),
}));

import { GET } from "@/app/(protected)/settings/export/route";

beforeEach(() => {
  state.role = "admin";
  state.fromCalls = [];
  state.requestedRoles = [];
});

describe("P1D export route role gate", () => {
  it("invokes the admin-only guard before any data access", async () => {
    const response = await GET();
    expect(state.requestedRoles).toEqual(["admin"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
  });

  it.each(["receptionist", "doctor", "manager"])(
    "denies a %s before a single table is queried — no ZIP is produced",
    async (role) => {
      state.role = role;
      await expect(GET()).rejects.toThrow("NEXT_REDIRECT");
      expect(state.fromCalls).toEqual([]);
    },
  );
});
