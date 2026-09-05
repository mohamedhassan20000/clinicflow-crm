/**
 * Finding 7 — the V2 flow stack must not survive an episode boundary.
 *
 * There are four boundaries. Three run in TypeScript and all funnel through
 * `resetConversationAssistantState`; the fourth is the SQL idle sweep, which
 * closes threads on a schedule with no process involved and therefore has to
 * clear the column itself.
 *
 * The stack previously survived three of the four: `resetFlowState` was called
 * from exactly one place, the assistant's own auto-close. A thread a staff
 * member closed kept its booking, and because a parked frame is *offered* back
 * ("we can continue the booking we started earlier"), the next episode could be
 * invited to resume work from the episode before it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({ resetFlowState: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/v2/store", () => store);

const admin = vi.hoisted(() => {
  const chain = {
    update: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    select: vi.fn(() => chain),
    maybeSingle: vi.fn(
      async (): Promise<{ data: { id: string } | null; error: { message: string } | null }> => ({
        data: { id: "conv-1" },
        error: null,
      }),
    ),
    in: vi.fn(() => chain),
    is: vi.fn(() => chain),
    lt: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    then: undefined as unknown,
  };
  return {
    chain,
    createClinicScopedAdminClient: vi.fn(() => ({ from: vi.fn(() => chain) })),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createClinicScopedAdminClient: admin.createClinicScopedAdminClient,
}));
vi.mock("@/lib/ai/audit", () => ({ logAgentTool: vi.fn(async () => undefined) }));

import {
  closeAndResetConversation,
  resetConversationAssistantState,
} from "@/lib/ai/conversation-reset";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("every TypeScript episode boundary clears the V2 flow stack", () => {
  it("clears it on a manual-close / reopen reset", async () => {
    await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "manual_close",
    });
    expect(store.resetFlowState).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "conv-1",
    });
  });

  it("clears it on a close-and-reset", async () => {
    await closeAndResetConversation({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "assistant_close",
    });
    expect(store.resetFlowState).toHaveBeenCalledWith({
      clinicId: "clinic-1",
      conversationId: "conv-1",
    });
  });

  it("clears it even when the legacy column update fails", async () => {
    admin.chain.maybeSingle.mockResolvedValueOnce({ data: null, error: { message: "boom" } });
    const result = await resetConversationAssistantState({
      clinicId: "clinic-1",
      conversationId: "conv-1",
      reason: "manual_close",
    });
    expect(result.ok).toBe(false);
    // A half-failed reset must not be the reason a booking survives the episode.
    expect(store.resetFlowState).toHaveBeenCalled();
  });
});

describe("the SQL idle sweep clears it too", () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260913120000_v2_patient_assistant_flow_state.sql",
    ),
    "utf8",
  );

  it("replaces close_idle_patient_ai_episodes and nulls ai_flow_state", () => {
    expect(migration).toContain(
      "create or replace function public.close_idle_patient_ai_episodes(",
    );
    const sweeper = migration.slice(
      migration.indexOf("create or replace function public.close_idle_patient_ai_episodes("),
    );
    expect(sweeper).toContain("ai_flow_state = null");
    // Alongside the legacy state it already cleared, not instead of it.
    expect(sweeper).toContain("ai_booking_stage = null");
    expect(sweeper).toContain("ai_collected_data = '{}'::jsonb");
  });

  it("keeps the sweeper's own service-role guard", () => {
    const sweeper = migration.slice(
      migration.indexOf("create or replace function public.close_idle_patient_ai_episodes("),
    );
    expect(sweeper).toContain("PATIENT_AI_SERVICE_ROLE_REQUIRED");
  });
});
