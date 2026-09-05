import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type { PermissionUserRole } from "@/lib/page-permissions";

/**
 * Phase 6 review fixes — P6-02, P6-05, P6-06, P6-07, P6-08, P6-09, P6-10.
 *
 * P6-01 and P6-03 are verified against the *real* per-family dispatch in
 * `phase6-document-dispatch.test.ts` (the review's §4 coverage note), and on the
 * rendered card in `tests/unit/components/phase6-document-confirmation-card.test.tsx`.
 * P6-04 and P6-11 live in `phase6-retention.test.ts` and the RLS suite.
 */

const mocks = vi.hoisted(() => ({
  assertStaffToolAccess: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasPermission: vi.fn(),
  getPageVisibilityState: vi.fn(),
  getReportVisibilityState: vi.fn(),
  previewDocumentCore: vi.fn(),
  resolveClinicalRecordIssueState: vi.fn(),
}));

vi.mock("@/lib/ai/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/authorization")>();
  return { ...actual, assertStaffToolAccess: mocks.assertStaffToolAccess };
});
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/ai/permissions", () => ({ hasAiUserPermission: mocks.hasPermission }));
vi.mock("@/lib/server-page-permissions", () => ({
  getPageVisibilityState: mocks.getPageVisibilityState,
}));
vi.mock("@/lib/server-report-permissions", () => ({
  getReportVisibilityState: mocks.getReportVisibilityState,
}));
vi.mock("@/lib/documents/mutations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/documents/mutations")>();
  return {
    ...actual,
    previewDocumentCore: mocks.previewDocumentCore,
    resolveClinicalRecordIssueState: mocks.resolveClinicalRecordIssueState,
  };
});

import { DOCUMENT_CATALOG } from "@/lib/documents/catalog";
import { REGISTERED_DOCUMENT_TYPE_CODES } from "@/lib/documents/module";
import {
  assertDocumentTypeAccess,
  documentIssueFamily,
} from "@/lib/documents/mutations";
import {
  describeIssuableDocuments,
  prepareDocumentIssue,
} from "@/lib/ai/documents/capability";
import { resourceExportSuggestion } from "@/lib/ai/resources/export-hatch";

const ADMIN: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "owner@example.com",
  fullName: "Clinic Owner",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};
const PATIENT_ID = "00000000-0000-4000-8000-00000000000a";
const RECORD_ID = "00000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-08-14T12:00:00.000Z");
const ROLES: PermissionUserRole[] = [
  "admin",
  "manager",
  "receptionist",
  "doctor",
  "assistant",
];

function summary(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      documentType: "REVENUE_REPORT",
      title: "Revenue Report",
      titleKey: "documents.catalog.revenueReport",
      locale: "en",
      generatedAt: NOW.toISOString(),
      highlights: [{ label: "from", value: "2026-07-01" }],
      body: [],
      ...overrides,
    },
    audit: { targetTable: "documents" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertStaffToolAccess.mockResolvedValue(undefined);
  mocks.getEntitlements.mockResolvedValue({ planSlug: "pro_ai" });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPageVisibilityState.mockResolvedValue("visible");
  mocks.getReportVisibilityState.mockResolvedValue("visible");
  mocks.previewDocumentCore.mockResolvedValue(summary());
  mocks.resolveClinicalRecordIssueState.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// P6-02 — the Reports-page gate the UI enforces
// ---------------------------------------------------------------------------

describe("P6-02 Reports-page visibility gate", () => {
  const ANALYTICAL_DOCUMENT_RESOLVERS = [
    "SALES_REPORT",
    "FOLLOW_UP_ANALYTICS_REPORT",
  ] as const;

  it("denies the two document-resolver analytical types when the Reports page is hidden", async () => {
    // These two declare `resolver.kind === "document"`, so keying the page gate
    // on `resolver.kind === "report"` silently dropped it — the UI 404s them
    // through `requireReportsIndexAccess()` while the Assistant issued them.
    mocks.getPageVisibilityState.mockImplementation(async (_u, slug: string) =>
      slug === "reports" ? "hidden" : "visible",
    );
    for (const code of ANALYTICAL_DOCUMENT_RESOLVERS) {
      expect(DOCUMENT_CATALOG[code].resolver.kind).toBe("document");
      const access = await assertDocumentTypeAccess(ADMIN, code);
      expect(access.ok, `${code} must be denied`).toBe(false);
      expect(!access.ok && access.code).toBe("reportNotVisible");
    }
  });

  it("allows them again once the Reports page is visible", async () => {
    for (const code of ANALYTICAL_DOCUMENT_RESOLVERS) {
      expect((await assertDocumentTypeAccess(ADMIN, code)).ok).toBe(true);
    }
  });

  it("matches the UI gate for every registered type × role × Reports visibility", async () => {
    for (const reportsVisible of [true, false]) {
      mocks.getPageVisibilityState.mockImplementation(async (_u, slug: string) =>
        slug === "reports" ? (reportsVisible ? "visible" : "hidden") : "visible",
      );
      for (const role of ROLES) {
        const user = { ...ADMIN, role } as AuthedUser;
        for (const code of REGISTERED_DOCUMENT_TYPE_CODES) {
          const catalog = DOCUMENT_CATALOG[code];
          // What the `actions/**` helpers do: role gate always; Reports page
          // gate whenever the type is issued from `/reports`; per-report grant
          // additionally for report-backed types (held visible here).
          const uiWouldAllow =
            (catalog.pageRoles as readonly string[]).includes(role) &&
            (!catalog.issuanceTrigger.href.startsWith("/reports") || reportsVisible);
          const access = await assertDocumentTypeAccess(user, code);
          expect(
            access.ok,
            `${code} / ${role} / reports=${reportsVisible}`,
          ).toBe(uiWouldAllow);
        }
      }
    }
  });

  it("omits both types from describe_documents for a Reports-hidden user", async () => {
    mocks.getPageVisibilityState.mockImplementation(async (_u, slug: string) =>
      slug === "reports" ? "hidden" : "visible",
    );
    const codes = (await describeIssuableDocuments(ADMIN)).map(
      (entry) => entry.document_type,
    );
    expect(codes).not.toContain("SALES_REPORT");
    expect(codes).not.toContain("FOLLOW_UP_ANALYTICS_REPORT");
    // A type with no Reports dependency is unaffected.
    expect(codes).toContain("GENERIC_DOCUMENT");
  });

  it("keeps the export hatch silent for follow_ups for a Reports-hidden user", async () => {
    mocks.getPageVisibilityState.mockImplementation(async (_u, slug: string) =>
      slug === "reports" ? "hidden" : "visible",
    );
    expect(await resourceExportSuggestion(ADMIN, "follow_ups")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// P6-05 — the not_supported path must not enumerate hidden types
// ---------------------------------------------------------------------------

describe("P6-05 unknown-type enumeration", () => {
  it("lists only types this exact user could actually issue", async () => {
    mocks.getReportVisibilityState.mockImplementation(
      async (_u, reportId: string) => (reportId === "revenue" ? "hidden" : "visible"),
    );
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "NOT_A_TYPE",
      params: {},
    });
    expect(outcome.status).toBe("not_supported");
    const listed = outcome.status === "not_supported" ? outcome.valid_document_types : [];
    // The role grants REVENUE_REPORT but the per-user report grant hides it, so
    // asking for it by name would be refused — it must not be advertised here.
    expect(DOCUMENT_CATALOG.REVENUE_REPORT.pageRoles).toContain("admin");
    expect(listed).not.toContain("REVENUE_REPORT");
  });

  it("matches describe_documents exactly", async () => {
    mocks.getReportVisibilityState.mockImplementation(
      async (_u, reportId: string) => (reportId === "revenue" ? "hidden" : "visible"),
    );
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "NOT_A_TYPE",
      params: {},
    });
    const described = (await describeIssuableDocuments(ADMIN)).map(
      (entry) => entry.document_type,
    );
    const listed = outcome.status === "not_supported" ? outcome.valid_document_types : [];
    expect([...listed].sort()).toEqual([...described].sort());
  });
});

// ---------------------------------------------------------------------------
// P6-06 — denial taxonomy
// ---------------------------------------------------------------------------

describe("P6-06 transient failure is not an authorization statement", () => {
  it("reports a resolver failure as transient_failure, not unauthorized_scope", async () => {
    mocks.previewDocumentCore.mockResolvedValue({ ok: false, code: "previewFailed" });
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "REVENUE_REPORT",
      params: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(outcome).toEqual({
      status: "transient_failure",
      document_type: "REVENUE_REPORT",
    });
  });

  it("still reports a genuine authorization miss as unauthorized_scope", async () => {
    mocks.previewDocumentCore.mockResolvedValue({
      ok: false,
      code: "documentTypeNotAvailable",
    });
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "REVENUE_REPORT",
      params: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(outcome).toEqual({
      status: "unauthorized_scope",
      document_type: "REVENUE_REPORT",
    });
  });
});

// ---------------------------------------------------------------------------
// P6-08 — unknown params keys are reported, never silently dropped
// ---------------------------------------------------------------------------

describe("P6-08 unknown params keys reach the model", () => {
  it("names a mis-cased slot alongside the slot it is still missing", async () => {
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "PATIENT_FILE",
      params: { patient_id: PATIENT_ID },
    });
    expect(outcome.status).toBe("missing_information");
    if (outcome.status !== "missing_information") return;
    expect(outcome.missing.map((slot) => slot.key)).toEqual(["patientId"]);
    expect(outcome.unknown_keys).toEqual(["patient_id"]);
  });

  it("reports smuggled keys on the ready path too", async () => {
    mocks.previewDocumentCore.mockResolvedValue(
      summary({ documentType: "PATIENT_FILE" }),
    );
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "PATIENT_FILE",
      params: { patientId: PATIENT_ID, clinic_id: "x", table: "profiles" },
    });
    expect(outcome.status).toBe("ready");
    expect(outcome.status === "ready" && outcome.unknown_keys.sort()).toEqual([
      "clinic_id",
      "table",
    ]);
  });
});

// ---------------------------------------------------------------------------
// P6-09 — localization and the document's own language
// ---------------------------------------------------------------------------

describe("P6-09 preview never shows a raw i18n key", () => {
  it("reports the resolved locale on the ready outcome", async () => {
    const outcome = await prepareDocumentIssue(
      ADMIN,
      { document_type: "REVENUE_REPORT", params: { from: "2026-07-01", to: "2026-07-31" } },
      { locale: "ar" },
    );
    expect(outcome.status === "ready" && outcome.locale).toBe("ar");
    expect(mocks.previewDocumentCore).toHaveBeenCalledWith(
      ADMIN,
      "REVENUE_REPORT",
      expect.anything(),
      { locale: "ar" },
    );
  });

  it("defaults to English only when no conversation locale is supplied", async () => {
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "REVENUE_REPORT",
      params: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(outcome.status === "ready" && outcome.locale).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// P6-03 (capability half) — the clinical record's state is resolved at preview
// ---------------------------------------------------------------------------

describe("P6-03 clinical record disclosure at preview", () => {
  beforeEach(() => {
    mocks.previewDocumentCore.mockResolvedValue(
      summary({ documentType: "PRESCRIPTION" }),
    );
  });

  it("reports a draft record as one issuance will finalize", async () => {
    mocks.resolveClinicalRecordIssueState.mockResolvedValue({
      table: "prescriptions",
      recordId: RECORD_ID,
      status: "draft",
      willFinalize: true,
    });
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "PRESCRIPTION",
      params: { recordId: RECORD_ID },
    });
    expect(outcome.status === "ready" && outcome.clinical_record).toEqual({
      table: "prescriptions",
      record_id: RECORD_ID,
      status: "draft",
      will_finalize: true,
    });
  });

  it("does not claim a finalization for an already-finalized record", async () => {
    mocks.resolveClinicalRecordIssueState.mockResolvedValue({
      table: "prescriptions",
      recordId: RECORD_ID,
      status: "finalized",
      willFinalize: false,
    });
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "PRESCRIPTION",
      params: { recordId: RECORD_ID },
    });
    expect(outcome.status === "ready" && outcome.clinical_record?.will_finalize).toBe(
      false,
    );
  });

  it("refuses at preview when the record is void, naming its state", async () => {
    mocks.resolveClinicalRecordIssueState.mockResolvedValue({
      table: "prescriptions",
      recordId: RECORD_ID,
      status: "void",
      willFinalize: false,
    });
    const outcome = await prepareDocumentIssue(ADMIN, {
      document_type: "PRESCRIPTION",
      params: { recordId: RECORD_ID },
    });
    expect(outcome).toEqual({
      status: "record_not_issuable",
      document_type: "PRESCRIPTION",
      record_id: RECORD_ID,
      record_status: "void",
    });
    // Refused before any snapshot resolution, so nothing was read needlessly.
    expect(mocks.previewDocumentCore).not.toHaveBeenCalled();
  });

  it("never resolves a clinical record state for a non-clinical type", async () => {
    mocks.previewDocumentCore.mockResolvedValue(summary());
    await prepareDocumentIssue(ADMIN, {
      document_type: "REVENUE_REPORT",
      params: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(mocks.resolveClinicalRecordIssueState).not.toHaveBeenCalled();
  });

  it("covers every clinical type", () => {
    for (const code of ["PRESCRIPTION", "LAB_REQUEST", "SICK_LEAVE_CERTIFICATE"] as const) {
      expect(documentIssueFamily(code)).toBe("clinical");
    }
  });
});
