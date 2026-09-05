import { describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";

vi.mock("server-only", () => ({}));

import {
  clearPendingActionConfirmation,
  ensureDoctorConversation,
  loadLatestDoctorConversation,
  persistDoctorTurn,
} from "@/lib/ai/conversations";

const USER: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "doctor@example.com",
  fullName: "Test Doctor",
  role: "doctor",
  avatarUrl: null,
  departmentId: "00000000-0000-4000-8000-000000000003",
  mustChangePassword: false,
};
const conversationId = "00000000-0000-4000-8000-000000000010";
const patientId = "00000000-0000-4000-8000-000000000011";

function chainWithMaybeSingle(maybeSingle: ReturnType<typeof vi.fn>) {
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "is", "order", "limit"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = maybeSingle;
  return chain;
}

function conversationClient(input: {
  existing?: { id: string; patient_id: string | null } | null;
  patient?: {
    id: string;
    assigned_doctor_id: string | null;
    department_id: string | null;
  } | null;
}) {
  const conversationMaybeSingle = vi
    .fn()
    .mockResolvedValue({ data: input.existing ?? null, error: null });
  const conversationChain = chainWithMaybeSingle(conversationMaybeSingle);
  const patientChain = chainWithMaybeSingle(
    vi.fn().mockResolvedValue({ data: input.patient ?? null, error: null }),
  );
  const upsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === "patients") {
      return { select: vi.fn(() => patientChain) };
    }
    return {
      select: vi.fn(() => conversationChain),
      upsert,
    };
  });
  return { supabase: { from } as never, upsert };
}

describe("P4B conversation hardening", () => {
  it("replays six same-timestamp messages deterministically by sequence", async () => {
    const createdAt = "2026-08-13T12:00:00.000Z";
    const rows = Array.from({ length: 6 }, (_, index) => {
      const sequence = 6 - index;
      return {
        id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
        role: sequence % 2 === 0 ? "assistant" : "user",
        content: `message-${sequence}`,
        created_at: createdAt,
        sequence,
      };
    });

    const messageOrder = vi.fn();
    const messageChain: Record<string, unknown> = {};
    messageChain.eq = vi.fn(() => messageChain);
    messageChain.order = messageOrder.mockImplementation(() => messageChain);
    messageChain.limit = vi.fn().mockResolvedValue({ data: rows, error: null });

    const conversationChain: Record<string, unknown> = {};
    for (const method of ["eq", "is", "order", "limit"]) {
      conversationChain[method] = vi.fn(() => conversationChain);
    }
    conversationChain.maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: conversationId,
        patient_id: null,
        title: "Stable replay",
        active_context: {},
      },
      error: null,
    });

    const from = vi.fn((table: string) => {
      if (table === "agent_messages") {
        return { select: vi.fn(() => messageChain) };
      }
      return { select: vi.fn(() => conversationChain) };
    });

    const loaded = await loadLatestDoctorConversation({
      supabase: { from } as never,
      user: USER,
    });

    expect(loaded?.messages.map((message) => ({
      role: message.role,
      text: message.parts[0]?.type === "text" ? message.parts[0].text : null,
    }))).toEqual([
      { role: "user", text: "message-1" },
      { role: "assistant", text: "message-2" },
      { role: "user", text: "message-3" },
      { role: "assistant", text: "message-4" },
      { role: "user", text: "message-5" },
      { role: "assistant", text: "message-6" },
    ]);
    expect(messageOrder.mock.calls).toEqual([
      ["created_at", { ascending: false }],
      ["sequence", { ascending: false }],
    ]);
  });

  it("treats an existing conversation patient mismatch as invalid client state", async () => {
    const { supabase } = conversationClient({
      existing: { id: conversationId, patient_id: patientId },
    });

    await expect(ensureDoctorConversation({
      supabase,
      user: USER,
      conversationId,
      locale: "en",
      patientId: "00000000-0000-4000-8000-000000000012",
    })).rejects.toMatchObject({ reason: "invalid_patient_context" });
  });

  it("rejects patient context outside the doctor's assignment and department", async () => {
    const { supabase, upsert } = conversationClient({
      patient: {
        id: patientId,
        assigned_doctor_id: "00000000-0000-4000-8000-000000000099",
        department_id: "00000000-0000-4000-8000-000000000098",
      },
    });

    await expect(ensureDoctorConversation({
      supabase,
      user: USER,
      conversationId,
      locale: "en",
      patientId,
    })).rejects.toMatchObject({ reason: "invalid_patient_context" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("keeps a validated first turn virtual until successful persistence", async () => {
    const { supabase, upsert } = conversationClient({
      patient: {
        id: patientId,
        assigned_doctor_id: USER.id,
        department_id: USER.departmentId,
      },
    });

    await expect(ensureDoctorConversation({
      supabase,
      user: USER,
      conversationId,
      locale: "en",
      patientId,
    })).resolves.toEqual({ id: conversationId, patientId, messages: [], activeContext: {} });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("re-selects and reuses a same-id row won by a concurrent successful turn", async () => {
    const conversationChain = chainWithMaybeSingle(
      vi.fn().mockResolvedValue({
        data: { id: conversationId, patient_id: patientId },
        error: null,
      }),
    );
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const updateChain: Record<string, unknown> = {
      eq: vi.fn(),
      is: vi.fn(),
      then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
    };
    updateChain.eq = vi.fn(() => updateChain);
    updateChain.is = vi.fn(() => updateChain);
    const from = vi.fn((table: string) => {
      if (table === "agent_messages") return { insert };
      return {
        upsert,
        select: vi.fn(() => conversationChain),
        update: vi.fn(() => updateChain),
      };
    });

    await expect(persistDoctorTurn({
      supabase: { from } as never,
      user: USER,
      conversationId,
      locale: "en",
      patientId,
      userText: "Summarize this patient",
      assistantText: "Summary",
    })).resolves.toBeUndefined();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ id: conversationId, patient_id: patientId }),
      { onConflict: "id", ignoreDuplicates: true },
    );
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("persists a preview-only assistant card so confirmation survives reload", async () => {
    const conversationChain = chainWithMaybeSingle(
      vi.fn().mockResolvedValue({
        data: { id: conversationId, patient_id: null, active_context: {} },
        error: null,
      }),
    );
    const insert = vi.fn().mockResolvedValue({ error: null });
    const updateChain: Record<string, unknown> = {
      then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
    };
    updateChain.eq = vi.fn(() => updateChain);
    updateChain.is = vi.fn(() => updateChain);
    const from = vi.fn((table: string) => table === "agent_messages"
      ? { insert }
      : {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn(() => conversationChain),
          update: vi.fn(() => updateChain),
        });
    const assistantParts = [{
      type: "tool-execute_action",
      toolCallId: "preview",
      state: "output-available",
      input: { action: "appointments.send_reminders", input: {} },
      output: {
        action_id: "appointments.send_reminders",
        phase: "preview",
        confirmation_required: true,
        confirm_token: "opaque-token",
        expires_at: "2026-08-13T12:10:00.000Z",
      },
    }] as never;

    await persistDoctorTurn({
      supabase: { from } as never,
      user: USER,
      conversationId,
      locale: "en",
      patientId: null,
      userText: "Send the reminders",
      assistantText: "",
      assistantParts,
      pendingConfirmations: [{
        action_id: "appointments.send_reminders",
        expires_at: "2026-08-13T12:10:00.000Z",
      }],
    });

    const rows = insert.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[1]?.parts).toEqual(assistantParts);
  });

  it("keeps an unexpired pending confirmation across a text continuation", async () => {
    const pending = {
      action_id: "appointments.send_reminders",
      expires_at: "2099-08-13T12:10:00.000Z",
    };
    const conversationChain = chainWithMaybeSingle(
      vi.fn().mockResolvedValue({
        data: {
          id: conversationId,
          patient_id: null,
          active_context: { pending_confirmations: [pending] },
        },
        error: null,
      }),
    );
    const update = vi.fn();
    const updateChain: Record<string, unknown> = {
      then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
    };
    updateChain.eq = vi.fn(() => updateChain);
    updateChain.is = vi.fn(() => updateChain);
    update.mockReturnValue(updateChain);
    const from = vi.fn((table: string) => table === "agent_messages"
      ? { insert: vi.fn().mockResolvedValue({ error: null }) }
      : {
          upsert: vi.fn().mockResolvedValue({ error: null }),
          select: vi.fn(() => conversationChain),
          update,
        });

    await persistDoctorTurn({
      supabase: { from } as never,
      user: USER,
      conversationId,
      locale: "en",
      patientId: null,
      userText: "What is still pending?",
      assistantText: "The preview is still awaiting your confirmation.",
      assistantParts: [{ type: "text", text: "The preview is still awaiting your confirmation." }],
      pendingConfirmations: [],
    });

    expect(update.mock.calls.some(([value]) =>
      value && typeof value === "object" && "active_context" in value,
    )).toBe(false);
  });

  it("removes only the completed confirmation and does not resurrect it on the next turn", async () => {
    const completed = {
      action_id: "appointments.send_reminders",
      expires_at: "2099-08-13T12:10:00.000Z",
    };
    const unrelated = {
      action_id: "invoices.send_reminders",
      expires_at: "2099-08-13T12:20:00.000Z",
    };
    const clearConversationChain = chainWithMaybeSingle(
      vi.fn().mockResolvedValue({
        data: {
          id: conversationId,
          active_context: { pending_confirmations: [completed, unrelated] },
        },
        error: null,
      }),
    );
    const clearUpdate = vi.fn();
    const clearUpdateChain: Record<string, unknown> = {
      then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
    };
    clearUpdateChain.eq = vi.fn(() => clearUpdateChain);
    clearUpdate.mockReturnValue(clearUpdateChain);
    const clearClient = {
      from: vi.fn(() => ({
        select: vi.fn(() => clearConversationChain),
        update: clearUpdate,
      })),
    } as never;

    await clearPendingActionConfirmation({
      supabase: clearClient,
      user: USER,
      conversationId,
      actionId: completed.action_id,
      expiresAt: completed.expires_at,
    });

    const clearedContext = (clearUpdate.mock.calls[0]?.[0] as {
      active_context: Record<string, unknown>;
    }).active_context;
    expect(clearedContext).toEqual({ pending_confirmations: [unrelated] });

    const nextConversationChain = chainWithMaybeSingle(
      vi.fn().mockResolvedValue({
        data: { id: conversationId, patient_id: null, active_context: clearedContext },
        error: null,
      }),
    );
    const nextUpdate = vi.fn();
    const nextUpdateChain: Record<string, unknown> = {
      then: (resolve: (value: { error: null }) => void) => resolve({ error: null }),
    };
    nextUpdateChain.eq = vi.fn(() => nextUpdateChain);
    nextUpdateChain.is = vi.fn(() => nextUpdateChain);
    nextUpdate.mockReturnValue(nextUpdateChain);
    const nextClient = {
      from: vi.fn((table: string) => table === "agent_messages"
        ? { insert: vi.fn().mockResolvedValue({ error: null }) }
        : {
            upsert: vi.fn().mockResolvedValue({ error: null }),
            select: vi.fn(() => nextConversationChain),
            update: nextUpdate,
          }),
    } as never;

    await persistDoctorTurn({
      supabase: nextClient,
      user: USER,
      conversationId,
      locale: "en",
      patientId: null,
      userText: "What remains pending?",
      assistantText: "One unrelated action remains pending.",
      pendingConfirmations: [],
    });

    expect(nextUpdate.mock.calls.some(([value]) =>
      value && typeof value === "object" && "active_context" in value,
    )).toBe(false);
  });
});
