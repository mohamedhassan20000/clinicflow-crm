import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type {
  ActionConfirmationStore,
  ActionReceiptLedger,
  ActionResolverContext,
  ConfirmationClaimOutcome,
} from "@/lib/ai/actions/types";

/**
 * P6-12 — subject-not-found is an authorization outcome, not an outage.
 *
 * The P6-06 remediation gave document previews a `transient_failure` outcome for
 * genuine infrastructure failures, but `previewFailed` was also the bucket every
 * resolver used to say "that record is not in your data" — so a patient the
 * caller cannot see was reported as a temporary problem, retried, and written to
 * the receipt ledger as `transient_failure`.
 *
 * These tests run the **real** resolvers, the real `previewDocumentCore`, the
 * real `prepareDocumentIssue` and the real action pipeline; only Supabase and
 * the authorization lookups beneath them are stubbed. They pin three things:
 *
 *  1. a subject that does not exist → `unauthorized_scope`
 *  2. a subject that exists but is out of scope → the **identical** outcome
 *  3. a genuine resolver/system failure → `transient_failure`
 */

type StubError = { code?: string; message: string } | null;
type StubResult = { data: unknown; error: StubError };

const mocks = vi.hoisted(() => ({
  results: new Map<string, { data: unknown; error: unknown }>(),
  assertStaffToolAccess: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasPermission: vi.fn(),
  getPageVisibilityState: vi.fn(),
  getReportVisibilityState: vi.fn(),
}));

/** Chainable PostgREST stub whose per-table result the test controls. */
function stubClient() {
  const make = (table: string) => {
    const result = () =>
      (mocks.results.get(table) as StubResult | undefined) ?? {
        data: null,
        error: null,
      };
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      neq: () => chain,
      or: () => chain,
      in: () => chain,
      is: () => chain,
      not: () => chain,
      gte: () => chain,
      lte: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => result(),
      single: async () => result(),
      then: (resolve: (value: unknown) => unknown) => {
        const current = result();
        return Promise.resolve({
          data: current.data ?? [],
          error: current.error ?? null,
        }).then(resolve);
      },
    };
    return chain;
  };
  return {
    from: (table: string) => make(table),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => stubClient(),
}));
vi.mock("@/lib/documents/renderers/registry", () => ({
  getDocumentPdfRenderer: () => async () => ({
    pdf: new Uint8Array(),
    pageCount: 1,
  }),
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
vi.mock("@/lib/supabase/admin", () => ({
  issueAiActionConfirmation: vi.fn(),
  verifyAiActionStepUp: vi.fn(),
  claimAiActionConfirmation: vi.fn(),
  beginAiActionReceipt: vi.fn(),
  finalizeAiActionReceipt: vi.fn(),
  consumeAiPrivilegedActionRateLimit: vi.fn(),
}));

import { prepareDocumentIssue } from "@/lib/ai/documents/capability";
import { previewRegisteredAction } from "@/lib/ai/actions/execute";
import { previewDocumentCore } from "@/lib/documents/mutations";
import {
  DocumentSubjectNotFoundError,
  isDocumentSubjectNotFoundError,
} from "@/lib/documents/resolvers/errors";
import { resolvePatientHistoryDocumentSnapshot } from "@/lib/documents/resolvers/patient-history";

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
const DOCTOR: AuthedUser = {
  ...ADMIN,
  id: "00000000-0000-4000-8000-000000000009",
  email: "doctor@example.com",
  fullName: "Dr Who",
  role: "doctor",
  departmentId: "00000000-0000-4000-8000-00000000000e",
};
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000003";
const PATIENT_ID = "00000000-0000-4000-8000-00000000000a";
const RECORD_ID = "00000000-0000-4000-8000-00000000000b";
const STAFF_ID = "00000000-0000-4000-8000-00000000000d";

/**
 * What PostgREST actually returns for `.single()` over zero rows — whether the
 * row is absent or RLS filtered it away. The two are indistinguishable at this
 * layer by construction, which is the property under test.
 */
const NO_ROWS: StubResult = {
  data: null,
  error: {
    code: "PGRST116",
    message: "JSON object requested, multiple (or no) rows returned",
  },
};
/** `.maybeSingle()` reports zero rows as no data and no error. */
const EMPTY: StubResult = { data: null, error: null };
/** A genuine infrastructure failure: statement timeout / connection loss. */
const TIMEOUT: StubResult = {
  data: null,
  error: { code: "57014", message: "canceling statement due to statement timeout" },
};
const CONNECTION_LOST: StubResult = {
  data: null,
  error: { code: "08006", message: "connection failure" },
};

const CONTEXT: ActionResolverContext = {
  conversationId: CONVERSATION_ID,
  locale: "en",
  activePatientId: null,
  activeAppointmentId: null,
};

class MemoryConfirmationStore implements ActionConfirmationStore {
  rows = new Map<
    string,
    { inputDigest: string; expiresAt: string; consumed: boolean }
  >();
  async issue(input: Parameters<ActionConfirmationStore["issue"]>[0]) {
    this.rows.set(input.tokenHash, {
      inputDigest: input.inputDigest,
      expiresAt: input.expiresAt,
      consumed: false,
    });
  }
  async claim(input: {
    tokenHash: string;
    inputDigest: string;
    consumedAt: string;
  }): Promise<ConfirmationClaimOutcome> {
    const row = this.rows.get(input.tokenHash);
    if (!row || row.inputDigest !== input.inputDigest) return "invalid";
    if (row.consumed) return "replayed";
    row.consumed = true;
    return "claimed";
  }
}

class MemoryReceiptLedger implements ActionReceiptLedger {
  finals: Array<Parameters<ActionReceiptLedger["finalize"]>[0]> = [];
  count = 0;
  async begin() {
    this.count += 1;
    return `00000000-0000-4000-8000-${String(this.count + 100).padStart(12, "0")}`;
  }
  async finalize(input: Parameters<ActionReceiptLedger["finalize"]>[0]) {
    this.finals.push(structuredClone(input));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.results.clear();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
  mocks.assertStaffToolAccess.mockResolvedValue(undefined);
  mocks.getEntitlements.mockResolvedValue({ planSlug: "pro_ai" });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPageVisibilityState.mockResolvedValue("visible");
  mocks.getReportVisibilityState.mockResolvedValue("visible");
  // Seeded so the *only* thing that can fail in each case below is the subject
  // lookup under test — a resolver that also blew up on branding would produce
  // `transient_failure` for the wrong reason.
  mocks.results.set("clinics", {
    data: {
      name: "Clinic",
      logo_url: null,
      address: null,
      phone: null,
      email: null,
      website: null,
      license_no: null,
      tax_id: null,
      document_footer: null,
      currency: "EGP",
      timezone: "Africa/Cairo",
      time_format: "24h",
    },
    error: null,
  });
  mocks.results.set("document_settings", { data: [], error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// The typed outcome the resolvers now raise
// ---------------------------------------------------------------------------

describe("the resolvers' not-found signal is typed, not message text", () => {
  it("carries the subject kind and nothing that could identify the record", () => {
    const error = new DocumentSubjectNotFoundError("patient");
    expect(isDocumentSubjectNotFoundError(error)).toBe(true);
    expect(JSON.stringify(Object.values(error))).not.toContain(PATIENT_ID);
    expect(error.subject).toBe("patient");
  });

  it("does not mistake an ordinary failure for a subject miss", () => {
    expect(isDocumentSubjectNotFoundError(new Error("Patient not found"))).toBe(
      false,
    );
    expect(isDocumentSubjectNotFoundError(undefined)).toBe(false);
  });

  it("maps to its own core failure code, distinct from previewFailed", async () => {
    mocks.results.set("patients", NO_ROWS);
    const missing = await previewDocumentCore(ADMIN, "PATIENT_FILE", {
      documentType: "PATIENT_FILE",
      patientId: PATIENT_ID,
    });
    expect(missing).toMatchObject({ ok: false, code: "documentSubjectNotFound" });

    mocks.results.set("patients", TIMEOUT);
    const broken = await previewDocumentCore(ADMIN, "PATIENT_FILE", {
      documentType: "PATIENT_FILE",
      patientId: PATIENT_ID,
    });
    expect(broken).toMatchObject({ ok: false, code: "previewFailed" });
  });
});

// ---------------------------------------------------------------------------
// prepareDocumentIssue — the three outcomes, per family
// ---------------------------------------------------------------------------

describe("a subject that cannot be resolved is unauthorized_scope, not transient", () => {
  const cases = [
    {
      name: "PATIENT_FILE (roster profile)",
      code: "PATIENT_FILE",
      params: { patientId: PATIENT_ID },
      table: "patients",
      /** `.single()` — an empty result arrives as PGRST116. */
      absent: NO_ROWS,
      failure: TIMEOUT,
    },
    {
      name: "STAFF_FILE (roster profile)",
      code: "STAFF_FILE",
      params: { staffId: STAFF_ID },
      table: "profiles",
      absent: NO_ROWS,
      failure: TIMEOUT,
    },
    {
      name: "PRESCRIPTION (clinical)",
      code: "PRESCRIPTION",
      params: { recordId: RECORD_ID },
      table: "prescriptions",
      /** `.maybeSingle()` — an empty result arrives as no data, no error. */
      absent: EMPTY,
      failure: CONNECTION_LOST,
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name}: a subject the caller cannot see is unauthorized_scope`, async () => {
      mocks.results.set(testCase.table, testCase.absent);
      const outcome = await prepareDocumentIssue(ADMIN, {
        document_type: testCase.code,
        params: testCase.params,
      });
      expect(outcome).toEqual({
        status: "unauthorized_scope",
        document_type: testCase.code,
      });
    });

    it(`${testCase.name}: a genuine resolver failure is still transient_failure`, async () => {
      mocks.results.set(testCase.table, testCase.failure);
      const outcome = await prepareDocumentIssue(ADMIN, {
        document_type: testCase.code,
        params: testCase.params,
      });
      expect(outcome).toEqual({
        status: "transient_failure",
        document_type: testCase.code,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// Non-enumeration: "does not exist" and "not yours" stay indistinguishable
// ---------------------------------------------------------------------------

describe("non-existent and out-of-scope subjects are indistinguishable", () => {
  /**
   * The strongest available pair: a patient-history document read by a doctor.
   * A missing patient never reaches the gate at all, while an existing patient
   * assigned to another doctor in another department is refused *after* the row
   * was read — two genuinely different code paths that must produce one output.
   */
  it("byte-identical outcomes for an absent patient and another doctor's patient", async () => {
    mocks.results.set("patients", NO_ROWS);
    const absent = await prepareDocumentIssue(DOCTOR, {
      document_type: "APPOINTMENT_HISTORY_REPORT",
      params: { patientId: PATIENT_ID, preset: "all" },
    });

    mocks.results.set("patients", {
      data: {
        id: PATIENT_ID,
        full_name: "Mona Ali",
        file_number: "P-1",
        phone: null,
        avatar_path: null,
        assigned_doctor_id: "00000000-0000-4000-8000-0000000000ff",
        department_id: "00000000-0000-4000-8000-0000000000fe",
      },
      error: null,
    });
    const outOfScope = await prepareDocumentIssue(DOCTOR, {
      document_type: "APPOINTMENT_HISTORY_REPORT",
      params: { patientId: PATIENT_ID, preset: "all" },
    });

    expect(JSON.stringify(outOfScope)).toBe(JSON.stringify(absent));
    expect(absent).toEqual({
      status: "unauthorized_scope",
      document_type: "APPOINTMENT_HISTORY_REPORT",
    });
  });

  it("the resolver itself raises the same typed error on both paths", async () => {
    const params = {
      documentType: "APPOINTMENT_HISTORY_REPORT" as const,
      patientId: PATIENT_ID,
      preset: "all" as const,
    };
    mocks.results.set("patients", NO_ROWS);
    const absent = await resolvePatientHistoryDocumentSnapshot(DOCTOR, params).catch(
      (error: unknown) => error,
    );
    mocks.results.set("patients", {
      data: {
        id: PATIENT_ID,
        full_name: "Mona Ali",
        file_number: "P-1",
        phone: null,
        avatar_path: null,
        assigned_doctor_id: "00000000-0000-4000-8000-0000000000ff",
        department_id: "00000000-0000-4000-8000-0000000000fe",
      },
      error: null,
    });
    const outOfScope = await resolvePatientHistoryDocumentSnapshot(
      DOCTOR,
      params,
    ).catch((error: unknown) => error);

    expect(isDocumentSubjectNotFoundError(absent)).toBe(true);
    expect(isDocumentSubjectNotFoundError(outOfScope)).toBe(true);
    expect((outOfScope as Error).message).toBe((absent as Error).message);
  });

  it("an unavailable document type produces the same outcome as a missing subject", async () => {
    // A receptionist may not issue a prescription at all; an admin may, but the
    // record is not in scope. Both are the same row of §11's taxonomy, and the
    // Assistant must not be able to tell them apart.
    mocks.results.set("prescriptions", EMPTY);
    const scopeMiss = await prepareDocumentIssue(ADMIN, {
      document_type: "PRESCRIPTION",
      params: { recordId: RECORD_ID },
    });
    const typeMiss = await prepareDocumentIssue(
      { ...ADMIN, role: "receptionist" },
      { document_type: "PRESCRIPTION", params: { recordId: RECORD_ID } },
    );
    expect(JSON.stringify(typeMiss)).toBe(JSON.stringify(scopeMiss));
  });
});

// ---------------------------------------------------------------------------
// The receipt ledger records the right denial reason
// ---------------------------------------------------------------------------

describe("documents.issue receipts classify the denial correctly", () => {
  async function previewIssue(params: Record<string, unknown>, code: string) {
    const ledger = new MemoryReceiptLedger();
    const result = await previewRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.issue",
      actionInput: { document_type: code, params },
      confirmationStore: new MemoryConfirmationStore(),
      receiptLedger: ledger,
      resolverContext: CONTEXT,
    });
    return { result, ledger };
  }

  it("an out-of-scope subject is denied unauthorized_scope on the receipt", async () => {
    mocks.results.set("patients", NO_ROWS);
    const { result, ledger } = await previewIssue(
      { patientId: PATIENT_ID },
      "PATIENT_FILE",
    );
    expect(result).toMatchObject({
      action_denied: true,
      reason: "unauthorized_scope",
    });
    expect(ledger.finals).toHaveLength(1);
    expect(ledger.finals[0]).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "unauthorized_scope",
    });
  });

  it("a genuine resolver failure is still denied transient_failure", async () => {
    mocks.results.set("patients", TIMEOUT);
    const { result, ledger } = await previewIssue(
      { patientId: PATIENT_ID },
      "PATIENT_FILE",
    );
    expect(result).toMatchObject({
      action_denied: true,
      reason: "transient_failure",
    });
    expect(ledger.finals[0]).toMatchObject({
      denialReason: "transient_failure",
    });
  });

  it("nothing is issued and no confirmation token is minted on either", async () => {
    mocks.results.set("prescriptions", EMPTY);
    const { result } = await previewIssue({ recordId: RECORD_ID }, "PRESCRIPTION");
    expect(result).not.toHaveProperty("confirm_token");
    expect(result).toMatchObject({
      action_denied: true,
      confirmation_required: false,
      reason: "unauthorized_scope",
    });
  });
});
