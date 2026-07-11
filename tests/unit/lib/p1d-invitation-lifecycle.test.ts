import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Stale/concurrent invitation-state behavior: the conditional UPDATE
 * (`status = 'pending'`) can match zero rows when another operator tab
 * accepted or revoked the row first. Issue/resend must never surface a raw
 * token whose hash was not persisted; revoke must never claim success while
 * the token stayed live.
 */

const state = vi.hoisted(() => ({
  updateResult: {
    data: [] as Array<{ id: string }>,
    error: null as { message: string } | null,
  },
  updatedRows: [] as Array<Record<string, unknown>>,
}));

function makeBuilder() {
  const calls = new Set<string>();
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "gt", "is", "order", "limit"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.update = vi.fn((values: Record<string, unknown>) => {
    calls.add("update");
    state.updatedRows.push(values);
    return builder;
  });
  builder.single = vi.fn(async () => ({ data: { invitation_expiry_days: 7 }, error: null }));
  builder.then = (resolve: (value: unknown) => void) => {
    if (calls.has("update")) return resolve(state.updateResult);
    return resolve({ data: null, count: 0, error: null });
  };
  return builder as never;
}

vi.mock("@/lib/rbac", () => ({
  requirePlatformAdmin: vi.fn(async () => ({ id: "operator-1", email: "op@example.com" })),
  requireMutationRole: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn(() => makeBuilder()),
    rpc: vi.fn(async () => ({
      data: [
        {
          registration_mode: "invite_only",
          weekly_invite_limit: 20,
          accepted_clinics_this_week: 0,
        },
      ],
      error: null,
    })),
  })),
}));
vi.mock("@/lib/supabase/admin", () => ({ requestClinicInvitation: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/signup", () => ({
  hashInvitationToken: (token: string) => `hash-${token}`,
  normalizeEmail: (email: string) => email,
  normalizePhone: (phone: string) => phone,
  requestIp: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import {
  issueClinicInvitation,
  resendClinicInvitation,
  revokeClinicInvitation,
} from "@/actions/early-access";

const INVITATION_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  state.updateResult = { data: [], error: null };
  state.updatedRows = [];
});

describe("P1D invitation lifecycle under stale/concurrent state", () => {
  it("refuses to surface a raw token when the issue update matched zero rows", async () => {
    state.updateResult = { data: [], error: null }; // concurrently accepted/revoked
    const result = await issueClinicInvitation(INVITATION_ID);
    expect(result.ok).toBeUndefined();
    expect(result.rawToken).toBeUndefined();
    expect(result.error).toMatch(/no longer pending/i);
  });

  it("returns the raw token only when the token hash was persisted", async () => {
    state.updateResult = { data: [{ id: INVITATION_ID }], error: null };
    const result = await issueClinicInvitation(INVITATION_ID);
    expect(result.ok).toBe(true);
    expect(result.rawToken).toBeTruthy();
    expect(state.updatedRows[0]?.token_hash).toBe(`hash-${result.rawToken}`);
  });

  it("resend inherits the same zero-row protection", async () => {
    state.updateResult = { data: [], error: null };
    const result = await resendClinicInvitation(INVITATION_ID);
    expect(result.rawToken).toBeUndefined();
    expect(result.error).toMatch(/no longer pending/i);
  });

  it("never reports a revoke as successful when nothing was revoked", async () => {
    state.updateResult = { data: [], error: null }; // already accepted / stale id
    const result = await revokeClinicInvitation(INVITATION_ID);
    expect(result.ok).toBeUndefined();
    expect(result.error).toMatch(/nothing was revoked/i);
  });

  it("reports a successful revoke when the row transitioned", async () => {
    state.updateResult = { data: [{ id: INVITATION_ID }], error: null };
    const result = await revokeClinicInvitation(INVITATION_ID);
    expect(result.ok).toBe(true);
  });
});
