import { beforeEach, describe, expect, it, vi } from "vitest";

const DOCUMENT_ID = "d4fd5ee3-2f05-40d7-8d90-d49a081d7a3f";
const CLINIC_ID = "caf2711f-97cb-4474-a103-f9505f467087";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  revalidatePath: vi.fn(),
  rpc: vi.fn(),
  documentStatus: "issued",
  documentFilters: [] as Array<[string, unknown]>,
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/rbac", () => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: "caf2711f-97cb-4474-a103-f9505f467087",
    email: "admin@clinic.test",
    role: "admin" as const,
    fullName: "Clinic Admin",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  };
  return {
    requireMutationUser: vi.fn(async () => user),
    requireUser: vi.fn(async () => user),
  };
});

function documentsQuery() {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => {
      mocks.documentFilters.push([column, value]);
      return query;
    }),
    maybeSingle: vi.fn(async () => ({
      data: {
        id: DOCUMENT_ID,
        doc_type: "PRESCRIPTION",
        document_number: "RX-2026-0001",
        status: mocks.documentStatus,
        locale: "en",
        patient_id: null,
        staff_id: null,
        doctor_id: null,
        appointment_id: null,
        issued_at: "2026-08-08T12:00:00.000Z",
        issued_by: USER_ID,
        print_count: 1,
        verification_token: "0123456789abcdef0123456789abcdef",
        page_count: 1,
      },
      error: null,
    })),
  });
  return query;
}

function eventsQuery() {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    order: vi.fn(async () => ({ data: [], error: null })),
  });
  return query;
}

function profilesQuery() {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: vi.fn(() => query),
    in: vi.fn(async () => ({
      data: [{ id: USER_ID, full_name: "Clinic Admin" }],
      error: null,
    })),
  });
  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      if (table === "documents") return documentsQuery();
      if (table === "document_events") return eventsQuery();
      if (table === "profiles") return profilesQuery();
      throw new Error(`Unexpected table: ${table}`);
    }),
    rpc: mocks.rpc,
  })),
}));

import { cancelClinicDocument } from "@/actions/documents-module";

describe("cancelClinicDocument RPC contract", () => {
  beforeEach(() => {
    mocks.revalidatePath.mockReset();
    mocks.rpc.mockReset();
    mocks.documentFilters = [];
    mocks.documentStatus = "issued";
  });

  it("looks up an authorized issued document and calls the exact cancellation RPC contract", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{
        document_id: DOCUMENT_ID,
        document_status: "cancelled",
        cancelled_at: "2026-08-09T10:00:00.000Z",
      }],
      error: null,
    });

    const result = await cancelClinicDocument(DOCUMENT_ID);

    expect(mocks.documentFilters).toEqual(
      expect.arrayContaining([
        ["clinic_id", CLINIC_ID],
        ["id", DOCUMENT_ID],
      ]),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("cancel_issued_document", {
      p_document_id: DOCUMENT_ID,
    });
    expect(result).toEqual({
      data: { documentId: DOCUMENT_ID, status: "cancelled" },
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/documents");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/documents/${DOCUMENT_ID}`);
  });

  it("logs every Postgres diagnostic field instead of reducing a PostgrestError to unknown", async () => {
    const rpcError = {
      code: "42703",
      message: 'column "old_state" of relation "activity_events" does not exist',
      details: null,
      hint: null,
    };
    mocks.rpc.mockResolvedValue({ data: null, error: rpcError });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const result = await cancelClinicDocument(DOCUMENT_ID);

      expect(result).toEqual({ errorCode: "cancelFailed" });
      expect(consoleError).toHaveBeenCalledWith("document_cancel_failed", {
        clinicId: CLINIC_ID,
        documentId: DOCUMENT_ID,
        rpc: "cancel_issued_document",
        code: "42703",
        message: rpcError.message,
        details: null,
        hint: null,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not call the RPC again for an already cancelled document", async () => {
    mocks.documentStatus = "cancelled";

    await expect(cancelClinicDocument(DOCUMENT_ID)).resolves.toEqual({
      data: { documentId: DOCUMENT_ID, status: "cancelled" },
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
