/**
 * The V2 RPC wrappers must call `rpc` *on* the client, not with it detached.
 *
 * This is the defect that made production QA look like a database problem.
 * `unappliedRpc()` returned `createAdminClient().rpc` — a bare reference to a
 * prototype method whose body is `return this.rest.rpc(...)`. Called
 * standalone, `this` is undefined and it throws a `TypeError` before a request
 * is ever built. `saveFlowState` caught the throw, `runPatientTurnV2` logged
 * `state_write_failed`, and the turn fell back to the legacy engine — so every
 * V2 turn in production was answered by V1 while the audit trail said the
 * write had failed. No SQL ran. There was no database error to find.
 *
 * Every existing V2 test mocks `@/lib/supabase/admin` wholesale, which is why
 * none of them could see this: the bug lived in the module they replaced. This
 * one mocks one layer lower — `@supabase/supabase-js` — and models the real
 * client's shape faithfully, `this`-dependence included.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const supabase = vi.hoisted(() => {
  const rest = {
    rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<unknown>>(
      () => Promise.resolve({ data: null, error: null }),
    ),
  };

  /**
   * The one detail that matters: `rpc` is on the prototype and reads
   * `this.rest`, exactly as `SupabaseClient` does. A plain object literal with
   * an arrow-function `rpc` would pass whether or not the call site binds, and
   * would have let this defect through a second time.
   */
  class FakeSupabaseClient {
    rest = rest;
    from = vi.fn();
    rpc(name: string, args: Record<string, unknown>) {
      return this.rest.rpc(name, args);
    }
  }

  return { rest, createClient: vi.fn(() => new FakeSupabaseClient()) };
});

vi.mock("@supabase/supabase-js", () => ({ createClient: supabase.createClient }));

import {
  resetConversationFlowState,
  setConversationFlowState,
} from "@/lib/supabase/admin";

const CLINIC = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  supabase.rest.rpc.mockClear();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

describe("V2 RPC wrappers keep their receiver", () => {
  it("reaches the RPC transport instead of throwing on a detached method", async () => {
    const result = await setConversationFlowState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
      flowState: { stack: [] },
    });

    // Before the fix this call rejected with
    // `TypeError: Cannot read properties of undefined (reading 'rest')`.
    expect(result.error).toBeNull();
    expect(supabase.rest.rpc).toHaveBeenCalledWith("set_conversation_flow_state", {
      p_clinic_id: CLINIC,
      p_conversation_id: CONVERSATION,
      p_flow_state: { stack: [] },
    });
  });

  it("binds the reset path too", async () => {
    // Same factory, same defect: the episode boundary was silently failing to
    // clear the stack for exactly the same reason.
    await resetConversationFlowState({
      clinicId: CLINIC,
      conversationId: CONVERSATION,
    });

    expect(supabase.rest.rpc).toHaveBeenCalledWith("reset_conversation_flow_state", {
      p_clinic_id: CLINIC,
      p_conversation_id: CONVERSATION,
    });
  });
});
