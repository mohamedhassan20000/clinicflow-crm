import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Post-plan product completion — change 2: conversation history.
 *
 * "New chat" always worked; what was missing was any way back. `/assistant`
 * loaded only the caller's *latest* conversation, so every earlier one was
 * still in `agent_conversations` and unreachable — effectively deleted from the
 * user's point of view.
 *
 * The fix adds a list and an open, and nothing else: no new table, no second
 * persistence mechanism, no relaxation of scope. These tests pin both halves —
 * that history is reachable, and that it is scoped exactly as tightly as every
 * other read in `lib/ai/conversations.ts`, including re-authorizing a
 * patient-bound conversation against the caller's *current* patient scope.
 */

const CLINIC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CLINIC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const DEPARTMENT = "22222222-2222-4222-8222-222222222222";
const MINE = "33333333-3333-4333-8333-333333333333";
const PATIENT_BOUND = "44444444-4444-4444-8444-444444444444";
const IN_SCOPE_PATIENT = "55555555-5555-4555-8555-555555555555";
const OUT_OF_SCOPE_PATIENT = "66666666-6666-4666-8666-666666666666";

function user(role: "admin" | "doctor" | "assistant" = "admin") {
  return {
    id: USER_ID,
    email: "staff@example.test",
    role,
    fullName: "Staff User",
    avatarUrl: null,
    clinicId: CLINIC,
    departmentId: role === "doctor" ? DEPARTMENT : null,
    mustChangePassword: false,
  };
}

type Filters = Record<string, unknown>;

/**
 * A Supabase stub that records the filters applied per table, so the scoping
 * assertions are made against what the query actually asked for rather than
 * against a hand-written expectation of it.
 */
function client(results: Record<string, { data: unknown; error: unknown }>) {
  const calls: { table: string; filters: Filters }[] = [];
  return {
    calls,
    supabase: {
      from(table: string) {
        const filters: Filters = {};
        calls.push({ table, filters });
        const chain: Record<string, unknown> = {
          select: () => chain,
          order: () => chain,
          limit: () => chain,
          eq: (column: string, value: unknown) => {
            filters[`eq:${column}`] = value;
            return chain;
          },
          is: (column: string, value: unknown) => {
            filters[`is:${column}`] = value;
            return chain;
          },
          in: (column: string, value: unknown) => {
            filters[`in:${column}`] = value;
            return chain;
          },
          maybeSingle: async () => results[table] ?? { data: null, error: null },
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve),
        };
        return chain;
      },
    },
  };
}

let conversations: typeof import("@/lib/ai/conversations");

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  conversations = await import("@/lib/ai/conversations");
});

describe("listAssistantConversations", () => {
  it("scopes the list to the caller's own active staff conversations in their clinic", async () => {
    const { supabase, calls } = client({
      agent_conversations: {
        data: [
          {
            id: MINE,
            title: "Which patients have O+ blood?",
            patient_id: null,
            updated_at: "2026-08-16T10:00:00.000Z",
            created_at: "2026-08-16T09:00:00.000Z",
          },
        ],
        error: null,
      },
    });

    const result = await conversations.listAssistantConversations({
      supabase: supabase as never,
      user: user(),
    });

    expect(result).toEqual([{
      id: MINE,
      title: "Which patients have O+ blood?",
      updatedAt: "2026-08-16T10:00:00.000Z",
      createdAt: "2026-08-16T09:00:00.000Z",
      patientBound: false,
    }]);
    expect(calls[0]!.filters).toMatchObject({
      "eq:clinic_id": CLINIC,
      "eq:user_id": USER_ID,
      "eq:persona": "doctor",
      "eq:status": "active",
    });
    // No patient ids in the page means no second read at all.
    expect(calls).toHaveLength(1);
  });

  it("drops a patient-bound conversation whose patient is no longer in the doctor's scope", async () => {
    const { supabase } = client({
      agent_conversations: {
        data: [
          {
            id: MINE,
            title: "General",
            patient_id: null,
            updated_at: "2026-08-16T10:00:00.000Z",
            created_at: "2026-08-16T09:00:00.000Z",
          },
          {
            id: PATIENT_BOUND,
            title: "About my patient",
            patient_id: IN_SCOPE_PATIENT,
            updated_at: "2026-08-16T09:30:00.000Z",
            created_at: "2026-08-16T09:00:00.000Z",
          },
          {
            id: "77777777-7777-4777-8777-777777777777",
            title: "About someone else's patient",
            patient_id: OUT_OF_SCOPE_PATIENT,
            updated_at: "2026-08-16T09:00:00.000Z",
            created_at: "2026-08-16T09:00:00.000Z",
          },
        ],
        error: null,
      },
      patients: {
        data: [
          {
            id: IN_SCOPE_PATIENT,
            assigned_doctor_id: USER_ID,
            department_id: null,
          },
          {
            id: OUT_OF_SCOPE_PATIENT,
            assigned_doctor_id: "99999999-9999-4999-8999-999999999999",
            department_id: "88888888-8888-4888-8888-888888888888",
          },
        ],
        error: null,
      },
    });

    const result = await conversations.listAssistantConversations({
      supabase: supabase as never,
      user: user("doctor"),
    });

    // The unauthorized row is *absent*, not shown with a denial: its title is
    // clinic-authored text about a patient this doctor may no longer see.
    expect(result.map((row) => row.id)).toEqual([MINE, PATIENT_BOUND]);
    expect(result[1]!.patientBound).toBe(true);
  });

  it("drops every patient-bound conversation for a role that may not hold one", async () => {
    const { supabase } = client({
      agent_conversations: {
        data: [{
          id: PATIENT_BOUND,
          title: "Patient chat",
          patient_id: IN_SCOPE_PATIENT,
          updated_at: "2026-08-16T09:30:00.000Z",
          created_at: "2026-08-16T09:00:00.000Z",
        }],
        error: null,
      },
      patients: {
        data: [{ id: IN_SCOPE_PATIENT, assigned_doctor_id: null, department_id: null }],
        error: null,
      },
    });
    // A patient binding exists only for doctor/assistant conversations; an admin
    // holding one is a corrupted row, and the list must not surface it.
    await expect(
      conversations.listAssistantConversations({
        supabase: supabase as never,
        user: user("admin"),
      }),
    ).resolves.toEqual([]);
  });

  it("caps the page at the module's own bound", async () => {
    expect(conversations.CONVERSATION_LIST_LIMIT).toBe(30);
    const { supabase } = client({ agent_conversations: { data: [], error: null } });
    await expect(
      conversations.listAssistantConversations({
        supabase: supabase as never,
        user: user(),
        limit: 5_000,
      }),
    ).resolves.toEqual([]);
  });

  it("surfaces a persistence failure rather than an empty list", async () => {
    const { supabase } = client({
      agent_conversations: { data: null, error: { message: "boom" } },
    });
    await expect(
      conversations.listAssistantConversations({
        supabase: supabase as never,
        user: user(),
      }),
    ).rejects.toMatchObject({ reason: "persistence_failed" });
  });
});

describe("loadAssistantConversationById", () => {
  function conversationClient(row: unknown, patient?: unknown, messages: unknown[] = []) {
    const calls: { table: string; filters: Filters }[] = [];
    let conversationReads = 0;
    return {
      calls,
      supabase: {
        from(table: string) {
          const filters: Filters = {};
          calls.push({ table, filters });
          const isConversation = table === "agent_conversations";
          if (isConversation) conversationReads += 1;
          const chain: Record<string, unknown> = {
            select: () => chain,
            order: () => chain,
            limit: () => chain,
            eq: (column: string, value: unknown) => {
              filters[`eq:${column}`] = value;
              return chain;
            },
            is: (column: string, value: unknown) => {
              filters[`is:${column}`] = value;
              return chain;
            },
            in: () => chain,
            maybeSingle: async () =>
              isConversation
                ? { data: row, error: null }
                : { data: patient ?? null, error: null },
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(
                table === "agent_messages"
                  ? { data: messages, error: null }
                  : { data: [], error: null },
              ).then(resolve),
          };
          return chain;
        },
      },
      conversationReads: () => conversationReads,
    };
  }

  it("returns the conversation with its persisted history for its owner", async () => {
    const { supabase, calls } = conversationClient(
      { id: MINE, patient_id: null, title: "Earlier chat", active_context: {} },
      undefined,
      // Newest first, as `loadMessages` orders it; the loader reverses.
      [
        {
          id: "m2",
          role: "assistant",
          content: "hi",
          parts: [{ type: "text", text: "hi" }],
          created_at: "t",
          sequence: 2,
        },
        { id: "m1", role: "user", content: "hello", parts: [], created_at: "t", sequence: 1 },
      ],
    );

    const loaded = await conversations.loadAssistantConversationById({
      supabase: supabase as never,
      user: user(),
      conversationId: MINE,
    });

    expect(loaded).toMatchObject({ id: MINE, title: "Earlier chat", patientId: null });
    expect(loaded!.messages).toHaveLength(2);
    // The text fallback for a pre-Phase-4 row without parts still applies.
    expect(loaded!.messages[0]!.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(calls[0]!.filters).toMatchObject({
      "eq:id": MINE,
      "eq:clinic_id": CLINIC,
      "eq:user_id": USER_ID,
      "eq:persona": "doctor",
      "eq:status": "active",
    });
  });

  it("returns null — never a denial — for a conversation that is not the caller's", async () => {
    const { supabase } = conversationClient(null);
    await expect(
      conversations.loadAssistantConversationById({
        supabase: supabase as never,
        user: { ...user(), clinicId: OTHER_CLINIC },
        conversationId: MINE,
      }),
    ).resolves.toBeNull();
  });

  it("re-authorizes a patient binding before returning any message", async () => {
    const { supabase, calls } = conversationClient(
      { id: PATIENT_BOUND, patient_id: OUT_OF_SCOPE_PATIENT, title: null, active_context: {} },
      {
        id: OUT_OF_SCOPE_PATIENT,
        assigned_doctor_id: "99999999-9999-4999-8999-999999999999",
        department_id: "88888888-8888-4888-8888-888888888888",
      },
    );

    await expect(
      conversations.loadAssistantConversationById({
        supabase: supabase as never,
        user: user("doctor"),
        conversationId: PATIENT_BOUND,
      }),
    ).resolves.toBeNull();
    // The transcript was never read.
    expect(calls.some((call) => call.table === "agent_messages")).toBe(false);
  });

  it("returns a patient-bound conversation the caller is still authorized for", async () => {
    const { supabase } = conversationClient(
      { id: PATIENT_BOUND, patient_id: IN_SCOPE_PATIENT, title: "Patient chat", active_context: {} },
      { id: IN_SCOPE_PATIENT, assigned_doctor_id: USER_ID, department_id: null },
      [],
    );
    await expect(
      conversations.loadAssistantConversationById({
        supabase: supabase as never,
        user: user("doctor"),
        conversationId: PATIENT_BOUND,
      }),
    ).resolves.toMatchObject({ id: PATIENT_BOUND, patientId: IN_SCOPE_PATIENT });
  });
});
