import { describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";

const USER = {
  id: "11111111-1111-4111-8111-111111111111",
  clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  role: "admin" as const,
  departmentId: null,
  email: "admin@clinic.test",
  fullName: "Admin",
  avatarUrl: null,
  mustChangePassword: false,
};
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const ENTITY = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

function existingSlot() {
  return {
    entity_type: "patient",
    entity_id: OTHER,
    display_label: "Existing patient",
    set_at: "2026-07-26T10:00:00.000Z",
    set_by: "resolution",
  };
}

async function loadAction(options: {
  conversation?: unknown;
  table?: string;
  entity?: unknown;
  rateLimitAllowed?: boolean;
} = {}) {
  vi.resetModules();
  const mocks = createServerActionMocks();
  const authorizeStaffAssistant = vi.fn(async () => USER);
  const assertAnalyticsToolAccess = vi.fn(async () => undefined);
  const assertFinancialInsightsAccess = vi.fn(async () => undefined);
  const checkRateLimit = vi.fn(async () => ({
    allowed: options.rateLimitAllowed ?? true,
    retryAfterSeconds: options.rateLimitAllowed === false ? 30 : 0,
    backendAvailable: true,
  }));
  const createClient = vi.fn(async () => mocks.client());

  mocks.state.tableResults["agent_conversations.select"] = {
    data:
      "conversation" in options
        ? options.conversation
        : { id: CONVERSATION, active_context: { patient: existingSlot() } },
    error: null,
  };
  mocks.state.tableResults["agent_conversations.update"] = {
    data: { id: CONVERSATION },
    error: null,
  };
  if (options.table) {
    mocks.state.tableResults[`${options.table}.select`] = {
      data: options.entity,
      error: null,
    };
  }

  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient,
  }));
  vi.doMock("@/lib/rate-limit", () => ({ checkRateLimit }));
  vi.doMock("@/lib/ai/authorization", () => ({
    authorizeStaffAssistant,
    assertAnalyticsToolAccess,
    assertFinancialInsightsAccess,
  }));
  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
  }));
  vi.doMock("next-intl/server", () => ({
    getLocale: vi.fn(async () => "en"),
  }));

  return {
    mocks,
    authorizeStaffAssistant,
    assertAnalyticsToolAccess,
    assertFinancialInsightsAccess,
    checkRateLimit,
    createClient,
    actions: await import("@/actions/assistant-context"),
  };
}

function updatePayload(
  mocks: ReturnType<typeof createServerActionMocks>,
): Record<string, unknown> {
  const update = mocks.state.queryLog.find(
    (entry) =>
      entry.table === "agent_conversations" && entry.operation === "update",
  );
  return (update?.args[0] ?? {}) as Record<string, unknown>;
}

describe("P4.10B explicit context choices", () => {
  it.each([
    {
      entityType: "patient",
      table: "patients",
      row: { full_name: "Canonical Patient" },
      label: "Canonical Patient",
      gate: "none",
    },
    {
      entityType: "appointment",
      table: "appointments",
      row: {
        scheduled_at: "2026-07-26T12:00:00.000Z",
        patients: { full_name: "Mona Ali" },
      },
      label: "Mona Ali · 2026-07-26T12:00:00.000Z",
      gate: "none",
    },
    {
      entityType: "invoice",
      table: "appointments",
      row: {
        outstanding_amount: 250,
        patients: { full_name: "Mona Ali" },
      },
      label: "Mona Ali · 250",
      gate: "financial",
    },
    {
      entityType: "staff",
      table: "profiles",
      row: { full_name: "Dr Ahmed" },
      label: "Dr Ahmed",
      gate: "analytics",
    },
    {
      entityType: "department",
      table: "departments",
      row: { name: "Cardiology" },
      label: "Cardiology",
      gate: "analytics",
    },
  ] as const)(
    "revalidates a $entityType choice and derives its UI label on the server",
    async ({ entityType, table, row, label, gate }) => {
      const loaded = await loadAction({ table, entity: row });

      const result =
        await loaded.actions.chooseAssistantConversationContext({
          conversationId: CONVERSATION,
          entityType,
          entityId: ENTITY,
        });

      expect(result).toMatchObject({
        success: true,
        activeContext: {
          patient: existingSlot(),
          [entityType]: {
            entity_type: entityType,
            entity_id: ENTITY,
            display_label: label,
            set_by: "user_choice",
          },
        },
      });
      expect(JSON.stringify(updatePayload(loaded.mocks))).not.toContain(
        '"display_label":"undefined"',
      );
      expect(loaded.assertAnalyticsToolAccess).toHaveBeenCalledTimes(
        gate === "analytics" ? 1 : 0,
      );
      expect(loaded.assertFinancialInsightsAccess).toHaveBeenCalledTimes(
        gate === "financial" ? 1 : 0,
      );
    },
  );

  it("revalidates an allow-listed report and its financial gate", async () => {
    const loaded = await loadAction();

    const result =
      await loaded.actions.chooseAssistantConversationContext({
        conversationId: CONVERSATION,
        entityType: "report",
        entityId: "revenue",
      });

    expect(result).toMatchObject({
      success: true,
      activeContext: {
        report: {
          entity_type: "report",
          entity_id: "revenue",
          display_label: "Revenue report",
          set_by: "user_choice",
        },
      },
    });
    expect(loaded.assertFinancialInsightsAccess).toHaveBeenCalledWith(USER);
  });

  it("rejects a stale or cross-clinic candidate without updating context", async () => {
    const loaded = await loadAction({ table: "patients", entity: null });

    await expect(
      loaded.actions.chooseAssistantConversationContext({
        conversationId: CONVERSATION,
        entityType: "patient",
        entityId: ENTITY,
      }),
    ).resolves.toEqual({ success: false, reason: "not_found" });
    expect(
      loaded.mocks.state.queryLog.some(
        (entry) =>
          entry.table === "agent_conversations" &&
          entry.operation === "update",
      ),
    ).toBe(false);
  });

  it("denies a foreign, archived, or missing conversation before resolving any candidate", async () => {
    const loaded = await loadAction({ conversation: null });

    await expect(
      loaded.actions.chooseAssistantConversationContext({
        conversationId: CONVERSATION,
        entityType: "patient",
        entityId: ENTITY,
      }),
    ).resolves.toEqual({ success: false, reason: "not_found" });
    expect(
      loaded.mocks.state.queryLog.some((entry) => entry.table === "patients"),
    ).toBe(false);

    const conversationRead = loaded.mocks.state.queryLog.filter(
      (entry) => entry.table === "agent_conversations",
    );
    for (const [column, value] of [
      ["clinic_id", USER.clinicId],
      ["user_id", USER.id],
      ["persona", "doctor"],
      ["status", "active"],
    ]) {
      expect(conversationRead).toContainEqual(
        expect.objectContaining({ args: ["eq", column, value] }),
      );
    }
  });
});

describe("P4.10B clear control", () => {
  it("clears only the requested slot on the owner's active conversation", async () => {
    const loaded = await loadAction({
      conversation: {
        id: CONVERSATION,
        active_context: {
          patient: existingSlot(),
          report: {
            entity_type: "report",
            entity_id: "no_shows",
            display_label: "No-show report",
            set_at: "2026-07-26T10:00:00.000Z",
            set_by: "resolution",
          },
        },
      },
    });

    const result =
      await loaded.actions.clearAssistantConversationContext({
        conversationId: CONVERSATION,
        entityType: "patient",
      });

    expect(result).toEqual({
      success: true,
      activeContext: {
        report: expect.objectContaining({ entity_id: "no_shows" }),
      },
    });
    expect(
      (updatePayload(loaded.mocks).active_context as Record<string, unknown>)
        .patient,
    ).toBeUndefined();
    expect(loaded.mocks.state.revalidatePath).toHaveBeenCalledWith(
      "/assistant",
    );
  });
});

describe("P410-L1 context mutation rate limiting", () => {
  it.each([
    {
      name: "choose",
      invoke: (actions: Awaited<ReturnType<typeof loadAction>>["actions"]) =>
        actions.chooseAssistantConversationContext({
          conversationId: CONVERSATION,
          entityType: "patient",
          entityId: ENTITY,
        }),
    },
    {
      name: "clear",
      invoke: (actions: Awaited<ReturnType<typeof loadAction>>["actions"]) =>
        actions.clearAssistantConversationContext({
          conversationId: CONVERSATION,
          entityType: "patient",
        }),
    },
  ])("rate-limits $name before creating a database client", async ({ invoke }) => {
    const loaded = await loadAction({ rateLimitAllowed: false });

    await expect(invoke(loaded.actions)).resolves.toEqual({
      success: false,
      reason: "rate_limited",
    });
    expect(loaded.checkRateLimit).toHaveBeenCalledWith(
      "assistant-context-mutation",
      `${USER.clinicId}:${USER.id}`,
      { limit: 30, windowSeconds: 60, failureMode: "open" },
    );
    expect(loaded.createClient).not.toHaveBeenCalled();
    expect(loaded.mocks.state.queryLog).toEqual([]);
  });

  it.each([
    {
      name: "choose",
      invoke: (actions: Awaited<ReturnType<typeof loadAction>>["actions"]) =>
        actions.chooseAssistantConversationContext({
          conversationId: CONVERSATION,
          entityType: "patient",
          entityId: ENTITY,
        }),
    },
    {
      name: "clear",
      invoke: (actions: Awaited<ReturnType<typeof loadAction>>["actions"]) =>
        actions.clearAssistantConversationContext({
          conversationId: CONVERSATION,
          entityType: "patient",
        }),
    },
  ])("invokes the shared limiter for an allowed $name mutation", async ({ invoke }) => {
    const loaded = await loadAction({ table: "patients", entity: { full_name: "Patient" } });

    await invoke(loaded.actions);
    expect(loaded.checkRateLimit).toHaveBeenCalledTimes(1);
  });
});
