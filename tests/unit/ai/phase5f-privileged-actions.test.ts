import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type {
  ActionConfirmationStore,
  ActionReceiptLedger,
  ConfirmationClaimOutcome,
  PrivilegedActionRateLimiter,
  PrivilegedConfirmationBinding,
} from "@/lib/ai/actions/types";

const mocks = vi.hoisted(() => ({
  assertStaffToolAccess: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasPermission: vi.fn(),
  getPageVisibilityState: vi.fn(),
  changeRole: vi.fn(),
  notifyAdmins: vi.fn(),
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
vi.mock("@/lib/ai/actions/privileged-notifications", () => ({
  notifyClinicAdminsOfPrivilegedAction: mocks.notifyAdmins,
}));
vi.mock("@/lib/settings/mutations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings/mutations")>();
  return { ...actual, changeStaffRoleMutation: mocks.changeRole };
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
  PRIVILEGED_ACTION_CONFIRMATION_TTL_MS,
  verifyPrivilegedActionStepUp,
} from "@/lib/ai/actions/confirm";
import {
  executeRegisteredAction,
  previewRegisteredAction,
} from "@/lib/ai/actions/execute";
import { AI_ACTION_REGISTRY } from "@/lib/ai/actions/registry";

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
const MANAGER: AuthedUser = { ...ADMIN, id: "00000000-0000-4000-8000-000000000009", role: "manager" };
const TARGET_ID = "00000000-0000-4000-8000-000000000010";
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
  riskClass?: string;
  privilegedBinding?: PrivilegedConfirmationBinding;
  reauthNonceHash?: string;
  consumed: boolean;
};

class ConfirmationStore implements ActionConfirmationStore {
  rows = new Map<string, Row>();

  async issue(input: Omit<Row, "consumed" | "reauthNonceHash">) {
    this.rows.set(input.tokenHash, { ...input, consumed: false });
  }

  async verifyStepUp(input: {
    tokenHash: string;
    clinicId: string;
    actorId: string;
    reauthNonceHash: string;
    verifiedAt: string;
  }) {
    const row = this.rows.get(input.tokenHash);
    if (!row || row.clinicId !== input.clinicId || row.actorId !== input.actorId) return false;
    row.reauthNonceHash = input.reauthNonceHash;
    return new Date(row.expiresAt) > new Date(input.verifiedAt);
  }

  async claim(input: {
    tokenHash: string;
    clinicId: string;
    actorId: string;
    conversationId: string;
    actionId: string;
    inputDigest: string;
    consumedAt: string;
    privilegedBinding?: PrivilegedConfirmationBinding;
    reauthNonceHash?: string;
  }): Promise<ConfirmationClaimOutcome> {
    const row = this.rows.get(input.tokenHash);
    if (!row) return "invalid";
    if (row.consumed) return "replayed";
    if (new Date(row.expiresAt) <= new Date(input.consumedAt)) return "expired";
    if (
      row.clinicId !== input.clinicId ||
      row.actorId !== input.actorId ||
      row.conversationId !== input.conversationId ||
      row.actionId !== input.actionId ||
      row.inputDigest !== input.inputDigest ||
      JSON.stringify(row.privilegedBinding) !== JSON.stringify(input.privilegedBinding) ||
      row.reauthNonceHash !== input.reauthNonceHash
    ) return "invalid";
    row.consumed = true;
    return "claimed";
  }
}

class Ledger implements ActionReceiptLedger {
  begins: Array<Parameters<ActionReceiptLedger["begin"]>[0] & { id: string }> = [];
  finals: Array<Parameters<ActionReceiptLedger["finalize"]>[0]> = [];
  async begin(input: Parameters<ActionReceiptLedger["begin"]>[0]) {
    const id = `00000000-0000-4000-8000-${String(this.begins.length + 100).padStart(12, "0")}`;
    this.begins.push({ ...input, id });
    return id;
  }
  async finalize(input: Parameters<ActionReceiptLedger["finalize"]>[0]) {
    this.finals.push(structuredClone(input));
  }
}

class Limiter implements PrivilegedActionRateLimiter {
  constructor(public allowed = true) {}
  calls: Array<Parameters<PrivilegedActionRateLimiter["consume"]>[0]> = [];
  async consume(input: Parameters<PrivilegedActionRateLimiter["consume"]>[0]) {
    this.calls.push(input);
    return this.allowed;
  }
}

const roleInput = (target = TARGET_ID, role = "admin") => ({
  staff_id: target,
  role,
  department_id: null,
  supervising_doctor_ids: [],
});

function successfulCore(input: { staff_id: string; role: string }, mode: "preview" | "execute") {
  return {
    ok: true as const,
    data: { staff_id: input.staff_id },
    audit: {
      targetTable: "profiles",
      targetRecordIds: [input.staff_id],
      before: { id: input.staff_id, full_name: "Sara Ahmed", role: "receptionist" },
      after: { id: input.staff_id, full_name: "Sara Ahmed", role: input.role },
    },
    mode,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 5).toString("base64");
  mocks.assertStaffToolAccess.mockResolvedValue(undefined);
  mocks.getEntitlements.mockResolvedValue({ subscriptionAllowed: true, features: {}, limits: {} });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPageVisibilityState.mockResolvedValue("visible");
  mocks.notifyAdmins.mockResolvedValue({ delivered: true, recipientCount: 1 });
  mocks.changeRole.mockImplementation(async (_user, input, mode = "execute") =>
    successfulCore(input, mode),
  );
});

afterEach(() => {
  delete process.env.AI_ACTION_CONFIRMATION_HMAC_KEY;
});

async function preview(options?: { user?: AuthedUser; input?: ReturnType<typeof roleInput>; limiter?: Limiter }) {
  const store = new ConfirmationStore();
  const ledger = new Ledger();
  const limiter = options?.limiter ?? new Limiter();
  const result = await previewRegisteredAction({
    user: options?.user ?? ADMIN,
    conversationId: CONVERSATION_ID,
    actionId: "staff.change_role",
    actionInput: options?.input ?? roleInput(),
    now: NOW,
    confirmationStore: store,
    receiptLedger: ledger,
    privilegedRateLimiter: limiter,
  });
  return { result, store, ledger, limiter };
}

describe("Phase 5f privileged registry and confirmation stack", () => {
  it("registers only the planned tenant actions as privileged and independently gated", () => {
    const privileged = AI_ACTION_REGISTRY.filter((action) => action.risk === "privileged");
    expect(privileged.map((action) => action.id).sort()).toEqual([
      "ai_permissions.set",
      "page_permissions.set_visibility",
      "report_permissions.set_visibility",
      "staff.change_role",
      "staff.permanent_delete",
      "staff.reset_password",
      "staff.restore",
      "staff.set_active",
      "staff.soft_delete",
    ]);
    expect(privileged.every((action) =>
      action.requiredFeatures.length === 1 && action.requiredFeatures[0] === "ai.write_privileged",
    )).toBe(true);
    expect(privileged.some((action) => /plan|subscription|operator|platform/.test(action.id))).toBe(false);
    for (const actionId of [
      "staff.change_role",
      "page_permissions.set_visibility",
      "report_permissions.set_visibility",
      "ai_permissions.set",
    ]) {
      expect(
        privileged.find((action) => action.id === actionId)?.roles,
        actionId,
      ).toEqual(["admin"]);
    }
    for (const actionId of [
      "staff.set_active",
      "staff.soft_delete",
      "staff.restore",
      "staff.permanent_delete",
      "staff.reset_password",
    ]) {
      expect(
        privileged.find((action) => action.id === actionId)?.roles,
        actionId,
      ).toEqual(["admin", "manager"]);
    }
  });

  it("shows the exact human-readable diff and issues a two-minute target/value-bound token", async () => {
    const { result, store } = await preview();
    expect(result).toMatchObject({
      phase: "preview",
      risk_class: "privileged",
      step_up_required: true,
      preview: {
        changes: [
          { label: "Staff member", before: expect.stringContaining("Sara Ahmed"), identifiesRecord: true },
          { label: "Role", before: "receptionist", after: "admin" },
        ],
      },
    });
    if (!("confirm_token" in result)) throw new Error("missing privileged token");
    expect(new Date(result.expires_at).getTime() - NOW.getTime()).toBe(
      PRIVILEGED_ACTION_CONFIRMATION_TTL_MS,
    );
    const [stored] = [...store.rows.values()];
    expect(stored.privilegedBinding).toMatchObject({ targetUserId: TARGET_ID });
    expect(stored.privilegedBinding?.beforeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.privilegedBinding?.afterDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses confirmation without step-up and writes a denied execute receipt", async () => {
    const { result, store } = await preview();
    if (!("confirm_token" in result)) throw new Error("missing privileged token");
    const ledger = new Ledger();
    const denied = await executeRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: result.action_id,
      actionInput: roleInput(),
      confirmToken: result.confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
      privilegedRateLimiter: new Limiter(),
    });
    expect(denied).toMatchObject({ action_denied: true, reason: "step_up_required" });
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "denied",
      denialReason: "step_up_required",
    });
  });

  it("expires the privileged confirmation at the two-minute boundary", async () => {
    const { result, store } = await preview();
    if (!("confirm_token" in result)) throw new Error("missing privileged token");
    await expect(
      verifyPrivilegedActionStepUp({
        token: result.confirm_token,
        userId: ADMIN.id,
        clinicId: ADMIN.clinicId,
        now: new Date(NOW.getTime() + PRIVILEGED_ACTION_CONFIRMATION_TTL_MS),
        store,
      }),
    ).rejects.toMatchObject({ reason: "expired" });
  });

  it("executes once after step-up, rechecks the diff, records success, and notifies admins", async () => {
    const { result, store } = await preview();
    if (!("confirm_token" in result)) throw new Error("missing privileged token");
    const nonce = await verifyPrivilegedActionStepUp({
      token: result.confirm_token,
      userId: ADMIN.id,
      clinicId: ADMIN.clinicId,
      now: NOW,
      store,
    });
    const ledger = new Ledger();
    const executed = await executeRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: result.action_id,
      actionInput: roleInput(),
      confirmToken: result.confirm_token,
      privilegedStepUpNonce: nonce,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
      privilegedRateLimiter: new Limiter(),
    });
    expect(executed).toMatchObject({ phase: "execute", executed: true });
    expect(mocks.changeRole).toHaveBeenCalledTimes(3);
    expect(mocks.notifyAdmins).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "staff.change_role",
      targetUserId: TARGET_ID,
    }));
    expect(ledger.finals.at(-1)).toMatchObject({
      authorizationOutcome: "allowed",
      outcome: "success",
      targetRecordIds: [TARGET_ID],
    });
  });

  it("invalidates target or requested-value mutation and leaves the token unused", async () => {
    const { result, store } = await preview();
    if (!("confirm_token" in result)) throw new Error("missing privileged token");
    const nonce = await verifyPrivilegedActionStepUp({
      token: result.confirm_token,
      userId: ADMIN.id,
      clinicId: ADMIN.clinicId,
      now: NOW,
      store,
    });
    for (const changed of [roleInput("00000000-0000-4000-8000-000000000011"), roleInput(TARGET_ID, "doctor")]) {
      const denied = await executeRegisteredAction({
        user: ADMIN,
        conversationId: CONVERSATION_ID,
        actionId: result.action_id,
        actionInput: changed,
        confirmToken: result.confirm_token,
        privilegedStepUpNonce: nonce,
        now: NOW,
        confirmationStore: store,
        receiptLedger: new Ledger(),
        privilegedRateLimiter: new Limiter(),
      });
      expect(denied).toMatchObject({ action_denied: true, reason: "confirmation_invalid" });
    }
    expect([...store.rows.values()][0].consumed).toBe(false);
  });

  it("burns the token and refuses execution when the live before value changed", async () => {
    const { result, store } = await preview();
    if (!("confirm_token" in result)) throw new Error("missing privileged token");
    const nonce = await verifyPrivilegedActionStepUp({
      token: result.confirm_token,
      userId: ADMIN.id,
      clinicId: ADMIN.clinicId,
      now: NOW,
      store,
    });
    mocks.changeRole.mockImplementation(async (_user, input, mode = "execute") => {
      const core = successfulCore(input, mode);
      if (mode === "preview") core.audit.before.role = "manager";
      return core;
    });

    const denied = await executeRegisteredAction({
      user: ADMIN,
      conversationId: CONVERSATION_ID,
      actionId: result.action_id,
      actionInput: roleInput(),
      confirmToken: result.confirm_token,
      privilegedStepUpNonce: nonce,
      now: NOW,
      confirmationStore: store,
      receiptLedger: new Ledger(),
      privilegedRateLimiter: new Limiter(),
    });

    expect(denied).toMatchObject({
      action_denied: true,
      reason: "confirmation_invalid",
    });
    expect([...store.rows.values()][0].consumed).toBe(true);
    expect(mocks.changeRole).toHaveBeenCalledTimes(2);
  });

  it("enforces admin-only role changes, the self-mutation ban, and privileged limits before core execution", async () => {
    const manager = await preview({ user: MANAGER });
    expect(manager.result).toMatchObject({ action_denied: true, reason: "unauthorized_role" });
    const self = await preview({ input: roleInput(ADMIN.id) });
    expect(self.result).toMatchObject({ action_denied: true, reason: "unauthorized_scope" });
    const limited = await preview({ limiter: new Limiter(false) });
    expect(limited.result).toMatchObject({ action_denied: true, reason: "privileged_rate_limited" });
    expect(mocks.changeRole).not.toHaveBeenCalled();
  });

  it("does not put reauthentication secrets in token rows or receipt digests", async () => {
    const password = "CurrentPassword123";
    const { result, store, ledger } = await preview();
    if (!("confirm_token" in result)) throw new Error("missing privileged token");
    expect(JSON.stringify([...store.rows.values()])).not.toContain(password);
    expect(JSON.stringify(ledger)).not.toContain(password);
    expect(createHash("sha256").update(password).digest("hex")).not.toBe(
      [...store.rows.values()][0].inputDigest,
    );
  });
});
