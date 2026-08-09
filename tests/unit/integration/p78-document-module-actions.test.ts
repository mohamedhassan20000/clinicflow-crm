import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P7-8 — the Central Document Factory's list action. These tests pin the
 * authorization boundary (role-aware type visibility, out-of-scope type ⇒ empty)
 * and the query shaping (clinic scope + issued-only + accessible-type filter),
 * without a live database.
 */

const mocks = vi.hoisted(() => ({
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "doc@clinic.test",
    role: "doctor" as "admin" | "manager" | "receptionist" | "doctor" | "assistant",
    fullName: "Dr. Who",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  },
  documentsResult: {
    data: [] as Record<string, unknown>[],
    error: null as unknown,
    count: 0,
  },
  draftsResult: {
    data: [] as Record<string, unknown>[],
    error: null as unknown,
  },
  lastDocumentsFilters: [] as Array<[string, unknown]>,
  lastDraftFilters: [] as Array<[string, unknown]>,
}));

vi.mock("@/lib/rbac", () => ({
  requireUser: vi.fn(async () => mocks.user),
}));

function tableBuilder(table: string) {
  const filters: Array<[string, unknown]> = [];
  const result =
    table === "documents"
      ? mocks.documentsResult
      : table === "document_drafts"
        ? mocks.draftsResult
      : { data: [] as Record<string, unknown>[], error: null };
  const query: Record<string, unknown> = {};
  const chain = (column: string, value: unknown) => {
    filters.push([column, value]);
    if (table === "documents") mocks.lastDocumentsFilters = filters;
    if (table === "document_drafts") mocks.lastDraftFilters = filters;
    return query;
  };
  Object.assign(query, {
    select: vi.fn(() => query),
    eq: vi.fn(chain),
    not: vi.fn((c: string, _op: string, v: unknown) => chain(c, v)),
    in: vi.fn(chain),
    or: vi.fn((expr: string) => chain("or", expr)),
    ilike: vi.fn(chain),
    gte: vi.fn(chain),
    lte: vi.fn(chain),
    is: vi.fn(chain),
    order: vi.fn(() => query),
    range: vi.fn(() => Promise.resolve(result)),
    limit: vi.fn(() => Promise.resolve(result)),
    maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
    then: (resolve: (value: unknown) => unknown) => resolve(result),
  });
  return query;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => tableBuilder(table)),
  })),
}));

import { listClinicDocuments } from "@/actions/documents-module";
import { getAccessibleDocumentTypeCodes } from "@/lib/documents/module";

beforeEach(() => {
  mocks.user.role = "doctor";
  mocks.documentsResult = { data: [], error: null, count: 0 };
  mocks.lastDocumentsFilters = [];
  mocks.draftsResult = { data: [], error: null };
  mocks.lastDraftFilters = [];
});

describe("P7-8 listClinicDocuments authorization", () => {
  it("returns an empty result for a type the role cannot access, without querying", async () => {
    const result = await listClinicDocuments({ type: "INVOICE" });
    expect(result.data?.rows).toEqual([]);
    expect(result.data?.total).toBe(0);
    // A doctor cannot see invoices — the guard short-circuits before any query.
    expect(mocks.lastDocumentsFilters).toEqual([]);
  });

  it("constrains the query to the role's accessible types when no type is chosen", async () => {
    await listClinicDocuments({});
    const inFilter = mocks.lastDocumentsFilters.find(([column]) => column === "doc_type");
    expect(inFilter).toBeDefined();
    expect(inFilter?.[1]).toEqual(getAccessibleDocumentTypeCodes("doctor"));
    // Always clinic-scoped and issued-only.
    expect(mocks.lastDocumentsFilters).toContainEqual(["clinic_id", mocks.user.clinicId]);
    expect(mocks.lastDocumentsFilters).toContainEqual(["issued_at", null]);
    expect(mocks.lastDocumentsFilters).toContainEqual([
      "status",
      ["issued", "cancelled", "void"],
    ]);
  });

  it("normalizes rows and derives the subject from the patient id", async () => {
    mocks.documentsResult = {
      data: [
        {
          id: "doc-1",
          doc_type: "PRESCRIPTION",
          document_number: "RX-0001",
          status: "issued",
          locale: "en",
          patient_id: "pat-1",
          staff_id: null,
          doctor_id: "dr-1",
          appointment_id: null,
          issued_at: "2026-08-01T09:00:00.000Z",
          issued_by: "dr-1",
          print_count: 2,
        },
      ],
      error: null,
      count: 1,
    };
    const result = await listClinicDocuments({});
    expect(result.data?.rows).toHaveLength(1);
    expect(result.data?.rows[0]).toMatchObject({
      id: "doc-1",
      docType: "PRESCRIPTION",
      documentNumber: "RX-0001",
      status: "issued",
      printCount: 2,
    });
  });

  it("keeps pre-existing issued documents visible when the optional draft query fails", async () => {
    mocks.documentsResult = {
      data: [
        {
          id: "legacy-issued-doc",
          doc_type: "PRESCRIPTION",
          document_number: "RX-LEGACY-0001",
          status: "issued",
          locale: "en",
          patient_id: null,
          staff_id: null,
          doctor_id: "dr-1",
          appointment_id: null,
          issued_at: "2026-07-01T09:00:00.000Z",
          issued_by: "dr-1",
          print_count: 1,
        },
      ],
      error: null,
      count: 1,
    };
    mocks.draftsResult = {
      data: [],
      error: {
        code: "PGRST205",
        message: "Could not find the table public.document_drafts",
      },
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await listClinicDocuments({});

      expect(result.errorCode).toBeUndefined();
      expect(result.data?.rows).toEqual([
        expect.objectContaining({
          id: "legacy-issued-doc",
          documentNumber: "RX-LEGACY-0001",
          status: "issued",
          isDraft: false,
        }),
      ]);
      expect(consoleError).toHaveBeenCalledWith(
        "document_module_draft_list_failed",
        expect.objectContaining({ clinicId: mocks.user.clinicId }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("combines pre-existing issued rows and new drafts without replacing either set", async () => {
    mocks.documentsResult = {
      data: [
        {
          id: "legacy-issued-doc",
          doc_type: "PRESCRIPTION",
          document_number: "RX-LEGACY-0001",
          status: "issued",
          locale: "en",
          patient_id: null,
          staff_id: null,
          doctor_id: "dr-1",
          appointment_id: null,
          issued_at: "2026-07-01T09:00:00.000Z",
          issued_by: "dr-1",
          print_count: 1,
        },
      ],
      error: null,
      count: 1,
    };
    mocks.draftsResult = {
      data: [
        {
          id: "new-draft",
          doc_type: "PRESCRIPTION",
          status: "not_issued",
          locale: "en",
          params: { recordId: "record-1" },
          patient_id: null,
          staff_id: null,
          doctor_id: "dr-1",
          appointment_id: null,
          created_by: mocks.user.id,
          updated_at: "2026-08-08T10:00:00.000Z",
        },
      ],
      error: null,
    };

    const result = await listClinicDocuments({});

    expect(result.data?.total).toBe(2);
    expect(result.data?.rows.map((row) => row.id)).toEqual([
      "new-draft",
      "legacy-issued-doc",
    ]);
    expect(result.data?.rows.map((row) => row.status)).toEqual([
      "not_issued",
      "issued",
    ]);
  });

  it("filters a single accessible type to just that type", async () => {
    await listClinicDocuments({ type: "PRESCRIPTION" });
    const inFilter = mocks.lastDocumentsFilters.find(([column]) => column === "doc_type");
    expect(inFilter?.[1]).toEqual(["PRESCRIPTION"]);
  });

  it("lists saved drafts immediately with the Not Issued status and preview link", async () => {
    mocks.draftsResult = {
      data: [{
        id: "draft-1",
        doc_type: "PRESCRIPTION",
        status: "not_issued",
        locale: "en",
        params: { recordId: "record-1" },
        patient_id: null,
        staff_id: null,
        doctor_id: null,
        appointment_id: null,
        created_by: mocks.user.id,
        updated_at: "2026-08-08T10:00:00.000Z",
      }],
      error: null,
    };
    const result = await listClinicDocuments({ status: "not_issued" });
    expect(result.data?.rows).toEqual([
      expect.objectContaining({
        id: "draft-1",
        status: "not_issued",
        documentNumber: null,
        isDraft: true,
        viewHref: expect.stringContaining("draftId=draft-1"),
        editHref: "/documents/new/clinical/prescription?draftId=draft-1",
      }),
    ]);
    expect(mocks.lastDraftFilters).toContainEqual(["status", "not_issued"]);
  });

  it("combines status, type, creator, patient, and date filters for drafts", async () => {
    mocks.user.role = "admin";
    await listClinicDocuments({
      status: "not_issued",
      type: "PRESCRIPTION",
      creatorId: mocks.user.id,
      patientId: "22222222-2222-4222-8222-222222222222",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-08",
    });
    expect(mocks.lastDraftFilters).toEqual(expect.arrayContaining([
      ["status", "not_issued"],
      ["doc_type", ["PRESCRIPTION"]],
      ["created_by", mocks.user.id],
      ["patient_id", "22222222-2222-4222-8222-222222222222"],
      ["updated_at", "2026-08-01T00:00:00.000Z"],
      ["updated_at", "2026-08-08T23:59:59.999Z"],
    ]));
  });
});
