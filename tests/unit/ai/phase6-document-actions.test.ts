import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type {
  ActionConfirmationStore,
  ActionReceiptLedger,
  ConfirmationClaimOutcome,
} from "@/lib/ai/actions/types";

const mocks = vi.hoisted(() => ({
  assertStaffToolAccess: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasPermission: vi.fn(),
  getPageVisibilityState: vi.fn(),
  getReportVisibilityState: vi.fn(),
  previewDocumentCore: vi.fn(),
  issueDocumentCore: vi.fn(),
  reprintDocumentCore: vi.fn(),
}));

vi.mock("@/lib/ai/authorization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/authorization")>();
  return { ...actual, assertStaffToolAccess: mocks.assertStaffToolAccess };
});
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/ai/permissions", () => ({
  hasAiUserPermission: mocks.hasPermission,
}));
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
    issueDocumentCore: mocks.issueDocumentCore,
    reprintDocumentCore: mocks.reprintDocumentCore,
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  issueAiActionConfirmation: vi.fn(),
  verifyAiActionStepUp: vi.fn(),
  claimAiActionConfirmation: vi.fn(),
  beginAiActionReceipt: vi.fn(),
  finalizeAiActionReceipt: vi.fn(),
  consumeAiPrivilegedActionRateLimit: vi.fn(),
}));

import {
  executeRegisteredAction,
  previewRegisteredAction,
} from "@/lib/ai/actions/execute";

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
const DOCTOR: AuthedUser = { ...ADMIN, id: "00000000-0000-4000-8000-000000000005", role: "doctor" };
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-08-14T12:00:00.000Z");

type Row = {
  tokenHash: string;
  clinicId: string;
  actorId: string;
  conversationId: string;
  actionId: string;
  inputDigest: string;
  expiresAt: string;
  consumed: boolean;
};

class MemoryConfirmationStore implements ActionConfirmationStore {
  rows = new Map<string, Row>();
  async issue(input: Omit<Row, "consumed">) {
    this.rows.set(input.tokenHash, { ...input, consumed: false });
  }
  async claim(input: {
    tokenHash: string;
    clinicId: string;
    actorId: string;
    conversationId: string;
    actionId: string;
    inputDigest: string;
    consumedAt: string;
  }): Promise<ConfirmationClaimOutcome> {
    const row = this.rows.get(input.tokenHash);
    if (
      !row ||
      row.clinicId !== input.clinicId ||
      row.actorId !== input.actorId ||
      row.conversationId !== input.conversationId ||
      row.actionId !== input.actionId ||
      row.inputDigest !== input.inputDigest
    ) {
      return "invalid";
    }
    if (row.consumed) return "replayed";
    if (new Date(row.expiresAt) <= new Date(input.consumedAt)) return "expired";
    row.consumed = true;
    return "claimed";
  }
}

class MemoryReceiptLedger implements ActionReceiptLedger {
  begins: Array<Parameters<ActionReceiptLedger["begin"]>[0] & { id: string }> = [];
  finals: Array<Parameters<ActionReceiptLedger["finalize"]>[0]> = [];
  async begin(input: Parameters<ActionReceiptLedger["begin"]>[0]) {
    const id = `00000000-0000-4000-8000-${String(this.begins.length + 10).padStart(12, "0")}`;
    this.begins.push({ ...input, id });
    return id;
  }
  async finalize(input: Parameters<ActionReceiptLedger["finalize"]>[0]) {
    this.finals.push(structuredClone(input));
  }
}

const READY_SUMMARY = {
  ok: true as const,
  data: {
    documentType: "REVENUE_REPORT" as const,
    title: "Revenue Report",
    titleKey: "documents.catalog.revenueReport",
    locale: "en" as const,
    generatedAt: NOW.toISOString(),
    highlights: [{ label: "from", value: "2026-07-01" }],
    body: [],
  },
  audit: { targetTable: "documents" },
};

const ISSUE_INPUT = {
  document_type: "REVENUE_REPORT",
  params: { from: "2026-07-01", to: "2026-07-31" },
  locale: "en" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
  mocks.assertStaffToolAccess.mockResolvedValue(undefined);
  mocks.getEntitlements.mockResolvedValue({ planSlug: "pro_ai" });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPageVisibilityState.mockResolvedValue("visible");
  mocks.getReportVisibilityState.mockResolvedValue("visible");
  mocks.previewDocumentCore.mockResolvedValue(READY_SUMMARY);
  mocks.issueDocumentCore.mockResolvedValue({
    ok: true,
    data: {
      documentId: "00000000-0000-4000-8000-0000000000d1",
      documentNumber: "REV-2026-0001",
      reused: false,
      detailHref: "/documents/00000000-0000-4000-8000-0000000000d1",
      pdfHref: "/documents/00000000-0000-4000-8000-0000000000d1/pdf",
    },
    audit: {
      targetTable: "documents",
      targetRecordIds: ["00000000-0000-4000-8000-0000000000d1"],
      before: { status: "not_issued" },
      after: { status: "issued" },
    },
  });
});

function preview(
  user = ADMIN,
  input: Record<string, unknown> = ISSUE_INPUT,
  store = new MemoryConfirmationStore(),
  ledger = new MemoryReceiptLedger(),
) {
  return previewRegisteredAction({
    user,
    conversationId: CONVERSATION_ID,
    actionId: "documents.issue",
    actionInput: input,
    now: NOW,
    confirmationStore: store,
    receiptLedger: ledger,
  }).then((result) => ({ result, store, ledger }));
}

describe("Phase 6 documents.issue action pipeline", () => {
  it("never issues on preview and mints a server-side confirm token", async () => {
    const { result, store, ledger } = await preview();
    expect(result).toMatchObject({
      action_id: "documents.issue",
      phase: "preview",
      risk_class: "sensitive",
      confirmation_required: true,
    });
    expect(mocks.issueDocumentCore).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(1);
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "allowed",
      outcome: "success",
    });
  });

  it("identifies the exact document in the confirmation card", async () => {
    const { result } = await preview();
    expect(
      "preview" in result &&
        result.preview.changes.some(
          (change) =>
            change.identifiesRecord === true &&
            String(change.after).includes("REVENUE_REPORT"),
        ),
    ).toBe(true);
  });

  it("refuses to preview when a required slot is still missing", async () => {
    const { result, ledger } = await preview(ADMIN, {
      document_type: "PATIENT_FILE",
      params: {},
      locale: "en",
    });
    expect(result).toMatchObject({
      action_denied: true,
      reason: "business_rule_violation",
    });
    expect(ledger.finals.at(-1)?.errorCode).toContain("missing_information");
    expect(mocks.issueDocumentCore).not.toHaveBeenCalled();
  });

  it("reports an unauthorized document type identically to an unknown one", async () => {
    // Reported identically to an unknown type, so an out-of-catalog type is
    // never confirmed to exist by the shape of the refusal. P6-12 moved both
    // onto §11's `unauthorized_scope` row — where a scope miss also lands —
    // rather than `business_rule_violation`, so the receipt ledger records
    // *why* the attempt was refused instead of a generic domain refusal.
    const { result, ledger } = await preview(DOCTOR, {
      document_type: "SYSTEM_MEMBERS_REPORT",
      params: {},
      locale: "en",
    });
    expect(result).toMatchObject({ reason: "unauthorized_scope" });
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "unauthorized_scope",
    });
    const unknown = await preview(DOCTOR, {
      document_type: "NOT_A_REAL_TYPE",
      params: {},
      locale: "en",
    });
    expect(unknown.result).toMatchObject({ reason: "unauthorized_scope" });
  });

  it("denies the whole family when the ai.documents feature is off", async () => {
    mocks.hasFeature.mockImplementation((_e, key: string) => key !== "ai.documents");
    const { result, ledger } = await preview();
    expect(result).toMatchObject({ reason: "plan_not_entitled" });
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "plan_not_entitled",
    });
  });

  it("issues only with a valid token and derives idempotency from it", async () => {
    const { result, store, ledger } = await preview();
    if (!("confirm_token" in result)) throw new Error("no token");
    const executed = await executeRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.issue",
      actionInput: ISSUE_INPUT,
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });
    expect(executed).toMatchObject({ phase: "execute", executed: true });
    expect(mocks.issueDocumentCore).toHaveBeenCalledTimes(1);
    const call = mocks.issueDocumentCore.mock.calls[0]!;
    expect(call[1]).toMatchObject({
      documentType: "REVENUE_REPORT",
      // §8.4 — the key is the confirm token's own derivation, not model input.
      idempotencyKey: expect.stringContaining("ai-action:"),
    });
    expect(call[2]).toBe("execute");
    expect(ledger.finals.at(-1)).toMatchObject({
      targetTable: "documents",
      outcome: "success",
    });
  });

  it("burns the token so a confirmed issue cannot be replayed", async () => {
    const { result, store, ledger } = await preview();
    if (!("confirm_token" in result)) throw new Error("no token");
    const args = {
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.issue",
      actionInput: ISSUE_INPUT,
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    };
    await executeRegisteredAction(args);
    const replay = await executeRegisteredAction(args);
    expect(replay).toMatchObject({ reason: "confirmation_replayed" });
    expect(mocks.issueDocumentCore).toHaveBeenCalledTimes(1);
  });

  it("cannot be executed with a token minted for different params", async () => {
    const { result, store, ledger } = await preview();
    if (!("confirm_token" in result)) throw new Error("no token");
    const tampered = await executeRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.issue",
      actionInput: {
        ...ISSUE_INPUT,
        params: { from: "2020-01-01", to: "2026-12-31" },
      },
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });
    expect(tampered).toMatchObject({ action_denied: true });
    expect(mocks.issueDocumentCore).not.toHaveBeenCalled();
  });

  it("re-asserts authorization at execute, so a revoked feature denies a confirmed issue", async () => {
    const { result, store, ledger } = await preview();
    if (!("confirm_token" in result)) throw new Error("no token");
    mocks.hasFeature.mockImplementation((_e, key: string) => key !== "ai.documents");
    const executed = await executeRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.issue",
      actionInput: ISSUE_INPUT,
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });
    expect(executed).toMatchObject({ reason: "plan_not_entitled" });
    expect(mocks.issueDocumentCore).not.toHaveBeenCalled();
  });

  it("relays a domain refusal from the issuance core without claiming success", async () => {
    mocks.issueDocumentCore.mockResolvedValue({ ok: false, code: "issueFailed" });
    const { result, store, ledger } = await preview();
    if (!("confirm_token" in result)) throw new Error("no token");
    const executed = await executeRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.issue",
      actionInput: ISSUE_INPUT,
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });
    expect(executed).toMatchObject({ reason: "business_rule_violation" });
    expect(ledger.finals.at(-1)).toMatchObject({
      outcome: "business_rule_refused",
      errorCode: "documents.issueFailed",
    });
  });
});

describe("Phase 6 documents.reprint action", () => {
  it("previews the exact document and its print count without reprinting", async () => {
    mocks.reprintDocumentCore.mockResolvedValue({
      ok: true,
      data: {
        documentId: "00000000-0000-4000-8000-0000000000d1",
        documentType: "REVENUE_REPORT",
        documentNumber: "REV-2026-0001",
        printCount: 2,
        pdfHref: "/documents/00000000-0000-4000-8000-0000000000d1/pdf",
      },
      audit: { targetTable: "documents" },
    });
    const result = await previewRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.reprint",
      actionInput: { document_id: "00000000-0000-4000-8000-0000000000d1" },
      now: NOW,
      confirmationStore: new MemoryConfirmationStore(),
      receiptLedger: new MemoryReceiptLedger(),
    });
    expect(result).toMatchObject({ risk_class: "normal", confirmation_required: true });
    expect(mocks.reprintDocumentCore).toHaveBeenCalledWith(
      ADMIN,
      "00000000-0000-4000-8000-0000000000d1",
      "preview",
    );
    expect(
      "preview" in result &&
        result.preview.changes.find((change) => change.label === "print_count"),
    ).toMatchObject({ before: 2, after: 3 });
  });

  it("refuses an out-of-scope document id without revealing whether it exists", async () => {
    mocks.reprintDocumentCore.mockResolvedValue({ ok: false, code: "documentNotFound" });
    const ledger = new MemoryReceiptLedger();
    const result = await previewRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: "documents.reprint",
      actionInput: { document_id: "00000000-0000-4000-8000-0000000000ff" },
      now: NOW,
      confirmationStore: new MemoryConfirmationStore(),
      receiptLedger: ledger,
    });
    expect(result).toMatchObject({ reason: "business_rule_violation" });
    expect(ledger.finals.at(-1)?.errorCode).toBe("documents.documentNotFound");
  });
});
