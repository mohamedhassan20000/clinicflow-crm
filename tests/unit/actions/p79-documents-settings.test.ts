import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryLog = {
  table: string;
  operation: "select" | "insert" | "update" | "delete";
  payload?: unknown;
  filters: Array<[string, unknown]>;
};

const mocks = vi.hoisted(() => ({
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    clinicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "owner@clinic.test",
    role: "admin" as const,
    fullName: "Owner",
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  },
  primary: true,
  existingRowId: null as string | null,
  writeError: null as unknown,
  logs: [] as QueryLog[],
  requireRole: vi.fn(),
  requireMutationRole: vi.fn(),
  isPrimaryClinicAdmin: vi.fn(),
  revalidatePath: vi.fn(),
  loadClinicDocumentCounters: vi.fn(),
}));

function builder(table: string) {
  const entry: QueryLog = { table, operation: "select", filters: [] };
  mocks.logs.push(entry);
  const query = {
    select: vi.fn(() => query),
    insert: vi.fn((payload: unknown) => {
      entry.operation = "insert";
      entry.payload = payload;
      return Promise.resolve({ data: null, error: mocks.writeError });
    }),
    update: vi.fn((payload: unknown) => {
      entry.operation = "update";
      entry.payload = payload;
      return query;
    }),
    delete: vi.fn(() => {
      entry.operation = "delete";
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      entry.filters.push([column, value]);
      return query;
    }),
    is: vi.fn((column: string, value: unknown) => {
      entry.filters.push([column, value]);
      return query;
    }),
    order: vi.fn(() => query),
    single: vi.fn(async () => {
      if (table === "clinics") {
        return { data: { name: "Clinic", logo_url: null, address: null, phone: null, email: null, website: null, license_no: null, tax_id: null, document_footer: null }, error: null };
      }
      return { data: null, error: null };
    }),
    maybeSingle: vi.fn(async () => ({
      data: mocks.existingRowId ? { id: mocks.existingRowId } : null,
      error: null,
    })),
    then: (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => {
      // Terminal for delete/update chains and list selects.
      const data =
        table === "document_settings" || table === "profiles" || table === "drug_catalog" || table === "lab_test_catalog"
          ? []
          : null;
      return Promise.resolve({ data, error: mocks.writeError }).then(resolve, reject);
    },
  };
  return query;
}

vi.mock("@/lib/rbac", () => ({
  requireRole: mocks.requireRole,
  requireMutationRole: mocks.requireMutationRole,
}));
vi.mock("@/lib/primary-admin", () => ({
  isPrimaryClinicAdmin: mocks.isPrimaryClinicAdmin,
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => builder(table) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  loadClinicDocumentCounters: mocks.loadClinicDocumentCounters,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/i18n/action-errors", () => ({
  actionError: async (key: string) => key,
}));

import {
  getDocumentSettingsOverview,
  saveDocumentSettings,
  resetDocumentSettings,
} from "@/actions/documents-settings";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.logs.length = 0;
  mocks.primary = true;
  mocks.existingRowId = null;
  mocks.writeError = null;
  mocks.requireRole.mockResolvedValue(mocks.user);
  mocks.requireMutationRole.mockResolvedValue(mocks.user);
  mocks.isPrimaryClinicAdmin.mockImplementation(async () => mocks.primary);
  mocks.loadClinicDocumentCounters.mockResolvedValue({ data: [], error: null });
});

describe("P7-9 getDocumentSettingsOverview", () => {
  it("denies a secondary admin without reading counters", async () => {
    mocks.primary = false;
    const result = await getDocumentSettingsOverview();
    expect(result.error).toBe(
      "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
    );
    expect(mocks.loadClinicDocumentCounters).not.toHaveBeenCalled();
  });

  it("returns a branding/type/clinician/catalog overview for the primary admin", async () => {
    const result = await getDocumentSettingsOverview();
    expect(result.error).toBeUndefined();
    expect(result.data?.types.length).toBeGreaterThan(0);
    expect(result.data?.branding.taxIdMissing).toBe(true);
    // Reads are scoped to the caller's clinic.
    const settingsRead = mocks.logs.find((l) => l.table === "document_settings");
    expect(settingsRead?.filters).toContainEqual(["clinic_id", mocks.user.clinicId]);
    expect(mocks.loadClinicDocumentCounters).toHaveBeenCalledWith(mocks.user.clinicId);
  });

  it("keeps the load error generic while logging the underlying query failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.writeError = { message: "relation document_settings does not exist" };

    const result = await getDocumentSettingsOverview();

    expect(result.error).toBe(
      "page-permissions.weCouldNotCompleteThisRequestPleaseTryAgain",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "document_settings_overview_query_error",
      expect.objectContaining({
        clinicId: mocks.user.clinicId,
        settingsError: "relation document_settings does not exist",
      }),
    );
    errorSpy.mockRestore();
  });
});

describe("P7-9 saveDocumentSettings", () => {
  it("inserts a new per-type row through the RLS client with clinic + updated_by", async () => {
    const result = await saveDocumentSettings({
      docType: "INVOICE",
      watermarkEnabled: true,
      watermarkText: "PAID",
      qrEnabled: true,
      numberingPrefix: "TAX",
      numberingYearlyReset: true,
      printOptions: {},
    });
    expect(result).toEqual({ success: true });
    expect(mocks.requireMutationRole).toHaveBeenCalledWith("admin");
    const insert = mocks.logs.find((l) => l.operation === "insert");
    expect(insert?.table).toBe("document_settings");
    expect(insert?.payload).toMatchObject({
      clinic_id: mocks.user.clinicId,
      doc_type: "INVOICE",
      updated_by: mocks.user.id,
      numbering_prefix: "TAX",
      watermark_text: "PAID",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/settings/documents");
  });

  it("updates the existing row by id when one is already stored", async () => {
    mocks.existingRowId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await expect(
      saveDocumentSettings({ docType: null, watermarkEnabled: false }),
    ).resolves.toEqual({ success: true });
    const update = mocks.logs.find((l) => l.operation === "update");
    expect(update?.table).toBe("document_settings");
    expect(update?.filters).toContainEqual(["id", mocks.existingRowId]);
    expect(update?.filters).toContainEqual(["clinic_id", mocks.user.clinicId]);
    expect(update?.payload).toMatchObject({ updated_by: mocks.user.id });
  });

  it("denies a secondary admin without any write", async () => {
    mocks.primary = false;
    const result = await saveDocumentSettings({ docType: "INVOICE" });
    expect(result.error).toBe(
      "page-permissions.onlyThePrimaryClinicAdminCanCustomizePageVisibility",
    );
    expect(mocks.logs.some((l) => l.operation !== "select")).toBe(false);
  });

  it("rejects an invalid prefix before authorization", async () => {
    const result = await saveDocumentSettings({
      docType: "INVOICE",
      numberingPrefix: "bad prefix",
    });
    expect(result.error).toBeDefined();
    expect(mocks.requireMutationRole).not.toHaveBeenCalled();
  });

  it("rejects an unregistered document type before authorization", async () => {
    const result = await saveDocumentSettings({
      // @ts-expect-error — intentionally invalid type for the guard test
      docType: "MADE_UP_TYPE",
    });
    expect(result.error).toBeDefined();
    expect(mocks.requireMutationRole).not.toHaveBeenCalled();
  });
});

describe("P7-9 resetDocumentSettings", () => {
  it("deletes the exact per-type row scoped to the clinic", async () => {
    await expect(resetDocumentSettings({ docType: "INVOICE" })).resolves.toEqual({
      success: true,
    });
    const del = mocks.logs.find((l) => l.operation === "delete");
    expect(del?.table).toBe("document_settings");
    expect(del?.filters).toContainEqual(["clinic_id", mocks.user.clinicId]);
    expect(del?.filters).toContainEqual(["doc_type", "INVOICE"]);
  });

  it("deletes the global row with a null doc_type filter", async () => {
    await expect(resetDocumentSettings({ docType: null })).resolves.toEqual({
      success: true,
    });
    const del = mocks.logs.find((l) => l.operation === "delete");
    expect(del?.filters).toContainEqual(["doc_type", null]);
  });

  it("denies a secondary admin without deleting", async () => {
    mocks.primary = false;
    const result = await resetDocumentSettings({ docType: "INVOICE" });
    expect(result.error).toBeDefined();
    expect(mocks.logs.some((l) => l.operation === "delete")).toBe(false);
  });
});
