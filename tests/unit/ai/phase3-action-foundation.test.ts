import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asSchema } from "ai";
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
}));

vi.mock("@/lib/ai/authorization", () => ({
  assertStaffToolAccess: mocks.assertStaffToolAccess,
}));
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
vi.mock("@/lib/supabase/admin", () => ({
  issueAiActionConfirmation: vi.fn(),
  claimAiActionConfirmation: vi.fn(),
  beginAiActionReceipt: vi.fn(),
  finalizeAiActionReceipt: vi.fn(),
}));

import {
  actionConfirmationExpiresAt,
  actionDigest,
  confirmationTokenHash,
  issueActionConfirmation,
  verifyAndClaimActionConfirmation,
} from "@/lib/ai/actions/confirm";
import {
  executeRegisteredAction,
  previewRegisteredAction,
} from "@/lib/ai/actions/execute";
import { AI_ACTION_REGISTRY } from "@/lib/ai/actions/registry";
import { isKnownAiFeature } from "@/lib/ai/commercial-policy";
import { executeActionTool } from "@/lib/ai/tools/execute-action";

const USER: AuthedUser = {
  id: "00000000-0000-4000-8000-000000000001",
  clinicId: "00000000-0000-4000-8000-000000000002",
  email: "admin@example.com",
  fullName: "Admin",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_CONVERSATION_ID = "00000000-0000-4000-8000-000000000004";
const INPUT = { label: "Phase 3 pipeline" };
const NOW = new Date("2026-08-13T12:00:00.000Z");

type StoredConfirmation = {
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
  rows = new Map<string, StoredConfirmation>();

  async issue(input: Omit<StoredConfirmation, "consumed">) {
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

async function preview(
  store = new MemoryConfirmationStore(),
  ledger = new MemoryReceiptLedger(),
) {
  const result = await previewRegisteredAction({
    user: USER,
    conversationId: CONVERSATION_ID,
    actionId: "assistant.reference_check",
    actionInput: INPUT,
    now: NOW,
    confirmationStore: store,
    receiptLedger: ledger,
  });
  if (!("confirm_token" in result)) throw new Error("preview did not issue token");
  return { result, store, ledger };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
  mocks.assertStaffToolAccess.mockResolvedValue(undefined);
  mocks.getEntitlements.mockResolvedValue({
    subscriptionAllowed: true,
    planSlug: "pro_ai",
    features: {},
    limits: {},
  });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPageVisibilityState.mockResolvedValue("visible");
});

afterEach(() => {
  delete process.env.AI_ACTION_CONFIRMATION_HMAC_KEY;
});

describe("Phase 3 confirm-token cryptography", () => {
  it("canonicalizes object keys and digests exact values", () => {
    expect(actionDigest({ b: 2, a: 1 })).toBe(actionDigest({ a: 1, b: 2 }));
    expect(actionDigest({ a: 1 })).not.toBe(actionDigest({ a: 2 }));
  });

  it("rejects a forged token signature before the store can claim it", async () => {
    const store = new MemoryConfirmationStore();
    const issued = await issueActionConfirmation({
      actionId: "assistant.reference_check",
      actionInput: INPUT,
      userId: USER.id,
      clinicId: USER.clinicId,
      conversationId: CONVERSATION_ID,
      now: NOW,
      store,
    });
    const forged = `${issued.token.slice(0, -1)}${issued.token.endsWith("A") ? "B" : "A"}`;

    await expect(
      verifyAndClaimActionConfirmation({
        token: forged,
        actionId: "assistant.reference_check",
        actionInput: INPUT,
        userId: USER.id,
        clinicId: USER.clinicId,
        conversationId: CONVERSATION_ID,
        now: NOW,
        store,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
    expect(store.rows.get(confirmationTokenHash(issued.token))?.consumed).toBe(false);
  });

  it("rejects argument mutation", async () => {
    const { result, store } = await preview();
    await expect(
      verifyAndClaimActionConfirmation({
        token: result.confirm_token,
        actionId: result.action_id,
        actionInput: { label: "mutated" },
        userId: USER.id,
        clinicId: USER.clinicId,
        conversationId: CONVERSATION_ID,
        now: NOW,
        store,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("rejects expiry without consuming the row", async () => {
    const { result, store } = await preview();
    await expect(
      verifyAndClaimActionConfirmation({
        token: result.confirm_token,
        actionId: result.action_id,
        actionInput: INPUT,
        userId: USER.id,
        clinicId: USER.clinicId,
        conversationId: CONVERSATION_ID,
        now: new Date("2026-08-13T12:10:00.001Z"),
        store,
      }),
    ).rejects.toMatchObject({ reason: "expired" });
    expect(store.rows.get(confirmationTokenHash(result.confirm_token))?.consumed).toBe(false);
  });

  it("rejects replay after one atomic claim", async () => {
    const { result, store } = await preview();
    const input = {
      token: result.confirm_token,
      actionId: result.action_id,
      actionInput: INPUT,
      userId: USER.id,
      clinicId: USER.clinicId,
      conversationId: CONVERSATION_ID,
      now: NOW,
      store,
    };
    await expect(verifyAndClaimActionConfirmation(input)).resolves.toMatchObject({
      idempotencyKey: expect.stringMatching(/^ai-action:[0-9a-f]{64}$/),
    });
    await expect(verifyAndClaimActionConfirmation(input)).rejects.toMatchObject({
      reason: "replayed",
    });
  });

  it("rejects cross-conversation reuse", async () => {
    const { result, store } = await preview();
    await expect(
      verifyAndClaimActionConfirmation({
        token: result.confirm_token,
        actionId: result.action_id,
        actionInput: INPUT,
        userId: USER.id,
        clinicId: USER.clinicId,
        conversationId: OTHER_CONVERSATION_ID,
        now: NOW,
        store,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it.each([
    ["action", { actionId: "assistant.different_action" }],
    ["user", { userId: "00000000-0000-4000-8000-000000000099" }],
    ["clinic", { clinicId: "00000000-0000-4000-8000-000000000098" }],
  ])("rejects reuse with a different %s binding", async (_binding, override) => {
    const { result, store } = await preview();
    await expect(
      verifyAndClaimActionConfirmation({
        token: result.confirm_token,
        actionId: result.action_id,
        actionInput: INPUT,
        userId: USER.id,
        clinicId: USER.clinicId,
        conversationId: CONVERSATION_ID,
        now: NOW,
        store,
        ...override,
      }),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("does not expose a confirmation token to model output or accept one as model input", async () => {
    const built = executeActionTool({ user: USER, locale: "en" });
    const schema = asSchema(built.inputSchema);
    await expect(
      schema.validate?.({
        action: "assistant.reference_check",
        input: INPUT,
        confirm_token: "model-forged-token",
      }),
    ).resolves.toMatchObject({ success: false });
    const projected = await built.toModelOutput?.({
      toolCallId: "call-1",
      input: { action: "assistant.reference_check", input: INPUT },
      output: {
        action_id: "assistant.reference_check",
        phase: "preview",
        risk_class: "normal",
        confirmation_required: true,
        confirm_token: "server-secret-token",
        expires_at: "2026-08-13T12:10:00.000Z",
        preview: { title: "Title", summary: "Summary", changes: [] },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("server-secret-token");
  });
});

describe("Phase 3 action executor and receipts", () => {
  it("retains the reference action and keeps every registered action feature-known", () => {
    // 87 through Phase 5f, plus Phase 6's documents.issue and documents.reprint.
    expect(AI_ACTION_REGISTRY).toHaveLength(89);
    expect(AI_ACTION_REGISTRY[0]).toMatchObject({
      id: "assistant.reference_check",
      risk: "normal",
      roles: ["admin"],
    });
    for (const action of AI_ACTION_REGISTRY) {
      expect(action.requiredFeatures.length).toBeGreaterThan(0);
      expect(action.requiredFeatures.every(isKnownAiFeature)).toBe(true);
    }
  });

  it("records allowed preview and execute receipts", async () => {
    const { result, store, ledger } = await preview();
    expect(actionConfirmationExpiresAt(result.confirm_token)).toBe(result.expires_at);
    const executed = await executeRegisteredAction({
      user: USER,
      conversationId: CONVERSATION_ID,
      actionId: result.action_id,
      actionInput: INPUT,
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });

    expect(executed).toMatchObject({
      phase: "execute",
      executed: true,
      confirmation_required: false,
    });
    expect(ledger.begins.map((row) => row.phase)).toEqual(["preview", "execute"]);
    expect(ledger.finals).toEqual([
      expect.objectContaining({
        authorizationOutcome: "allowed",
        outcome: "success",
      }),
      expect.objectContaining({
        authorizationOutcome: "allowed",
        outcome: "success",
      }),
    ]);
  });

  it("burns the token, re-authorizes, and records a denied stale-role attempt", async () => {
    const { result, store, ledger } = await preview();
    const revokedUser = { ...USER, role: "receptionist" as const };
    const denied = await executeRegisteredAction({
      user: revokedUser,
      conversationId: CONVERSATION_ID,
      actionId: result.action_id,
      actionInput: INPUT,
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });

    expect(denied).toMatchObject({
      action_denied: true,
      reason: "unauthorized_role",
    });
    expect(store.rows.get(confirmationTokenHash(result.confirm_token))?.consumed).toBe(true);
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "unauthorized_role",
      outcome: "error",
    });
  });

  it("records a denied forged-token execute attempt", async () => {
    const { result, store, ledger } = await preview();
    // The signature is base64url of 32 bytes, so its final character carries
    // only two significant bits and is always one of A/Q/g/w. Hard-coding "A"
    // as the forgery left the token *unchanged* about a quarter of the time —
    // the run then legitimately succeeded and the assertion failed, which is
    // what made this suite intermittently red. Swap to a character that is
    // guaranteed to differ in those two bits.
    const last = result.confirm_token.slice(-1);
    const forged = `${result.confirm_token.slice(0, -1)}${last === "A" ? "Q" : "A"}`;
    expect(forged).not.toBe(result.confirm_token);
    const denied = await executeRegisteredAction({
      user: USER,
      conversationId: CONVERSATION_ID,
      actionId: result.action_id,
      actionInput: INPUT,
      confirmToken: forged,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });
    expect(denied).toMatchObject({
      action_denied: true,
      reason: "confirmation_invalid",
    });
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "confirmation_invalid",
    });
  });

  it("preserves the invoice action's financial permission denial", async () => {
    mocks.hasPermission.mockResolvedValueOnce(false);
    const ledger = new MemoryReceiptLedger();
    const result = await previewRegisteredAction({
      user: USER,
      conversationId: CONVERSATION_ID,
      actionId: "invoices.send_reminders",
      actionInput: {
        invoices: [{ appointment_id: "00000000-0000-4000-8000-000000000020" }],
      },
      receiptLedger: ledger,
    });
    expect(result).toMatchObject({
      action_denied: true,
      reason: "permission_not_granted",
    });
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "permission_not_granted",
    });
  });

  it("preserves migrated-action role and page-visibility denials as separate controls", async () => {
    const roleLedger = new MemoryReceiptLedger();
    const roleDenied = await previewRegisteredAction({
      user: { ...USER, role: "receptionist" },
      conversationId: CONVERSATION_ID,
      actionId: "invoices.send_reminders",
      actionInput: {
        invoices: [{ appointment_id: "00000000-0000-4000-8000-000000000020" }],
      },
      receiptLedger: roleLedger,
    });
    expect(roleDenied).toMatchObject({
      action_denied: true,
      reason: "unauthorized_role",
    });

    mocks.getPageVisibilityState.mockResolvedValueOnce("hidden");
    const pageLedger = new MemoryReceiptLedger();
    const pageDenied = await previewRegisteredAction({
      user: USER,
      conversationId: CONVERSATION_ID,
      actionId: "appointments.send_reminders",
      actionInput: {
        appointments: [{ id: "00000000-0000-4000-8000-000000000020" }],
      },
      receiptLedger: pageLedger,
    });
    expect(pageDenied).toMatchObject({
      action_denied: true,
      reason: "unauthorized_scope",
    });
    expect(pageLedger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "unauthorized_scope",
    });
  });
});
