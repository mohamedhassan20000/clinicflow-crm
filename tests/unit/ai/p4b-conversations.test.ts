import { describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";

vi.mock("server-only", () => ({}));

import {
  ensureDoctorConversation,
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
    })).resolves.toEqual({ id: conversationId, patientId, messages: [] });
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
});
