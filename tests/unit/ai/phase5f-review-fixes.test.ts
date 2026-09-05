import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type {
  ActionConfirmationStore,
  ActionReceiptLedger,
  ConfirmationClaimOutcome,
  PrivilegedActionRateLimiter,
  PrivilegedConfirmationBinding,
} from "@/lib/ai/actions/types";

/**
 * Phase 5f review fixes — F1, F2, F3 (Assistant boundary half) and F5.
 *
 * The sibling `phase5f-settings-parity.test.ts` pins the UI half of F3 and all
 * of F4. F1's real proof is the browser E2E; the check here is the standing
 * guard that its Phase 0b seeding cannot silently rot away again.
 */

const mocks = vi.hoisted(() => ({
  assertStaffToolAccess: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasPermission: vi.fn(),
  getPageVisibilityState: vi.fn(),
  changeRole: vi.fn(),
  isPrimaryClinicAdmin: vi.fn(),
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
vi.mock("@/lib/primary-admin", () => ({
  isPrimaryClinicAdmin: mocks.isPrimaryClinicAdmin,
  getPrimaryClinicAdminId: vi.fn(),
}));
vi.mock("@/lib/settings/mutations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/settings/mutations")>();
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

import { verifyPrivilegedActionStepUp } from "@/lib/ai/actions/confirm";
import {
  executeRegisteredAction,
  previewRegisteredAction,
  PRIVILEGED_NOTIFICATION_FAILURE_ACTION_ID,
} from "@/lib/ai/actions/execute";
import { ActionPreviewContractError } from "@/lib/ai/actions/types";
import type { PrivilegedNotificationResult } from "@/lib/ai/actions/privileged-notifications";

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
    if (!row || row.clinicId !== input.clinicId || row.actorId !== input.actorId) {
      return false;
    }
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
      JSON.stringify(row.privilegedBinding) !==
        JSON.stringify(input.privilegedBinding) ||
      row.reauthNonceHash !== input.reauthNonceHash
    ) {
      return "invalid";
    }
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
  async consume() {
    return true;
  }
}

const roleInput = (role = "manager") => ({
  staff_id: TARGET_ID,
  role,
  department_id: null,
  supervising_doctor_ids: [] as string[],
});

/**
 * Mirrors the real `updateStaffMutation` shape: `before.supervising_doctor_ids`
 * and `after.supervising_doctor_ids` are always two *distinct* array instances
 * read separately from the database, even when they hold the same ids.
 */
function coreResult(
  input: { staff_id: string; role: string },
  mode: "preview" | "execute",
  options: { beforeDoctors?: string[]; afterDoctors?: string[] } = {},
) {
  const before = {
    id: input.staff_id,
    full_name: "Sara Ahmed",
    role: "receptionist",
    department_id: null,
    phone: null,
    is_active: true,
    supervising_doctor_ids: [...(options.beforeDoctors ?? [])],
  };
  return {
    ok: true as const,
    data: { staff_id: input.staff_id },
    audit: {
      targetTable: "profiles",
      targetRecordIds: [input.staff_id],
      before,
      after: {
        ...before,
        role: input.role,
        supervising_doctor_ids: [
          ...(options.afterDoctors ?? options.beforeDoctors ?? []),
        ],
      },
    },
    mode,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 5).toString("base64");
  mocks.assertStaffToolAccess.mockResolvedValue(undefined);
  mocks.getEntitlements.mockResolvedValue({
    subscriptionAllowed: true,
    features: {},
    limits: {},
  });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPageVisibilityState.mockResolvedValue("visible");
  mocks.isPrimaryClinicAdmin.mockResolvedValue(false);
  mocks.changeRole.mockImplementation(
    async (_user: AuthedUser, input: { staff_id: string; role: string }, mode = "execute") =>
      coreResult(input, mode as "preview" | "execute"),
  );
});

function preview(input = roleInput()) {
  const store = new ConfirmationStore();
  const ledger = new Ledger();
  return previewRegisteredAction({
    user: ADMIN,
    conversationId: CONVERSATION_ID,
    actionId: "staff.change_role",
    actionInput: input,
    now: NOW,
    confirmationStore: store,
    receiptLedger: ledger,
    privilegedRateLimiter: new Limiter(),
  }).then((result) => ({ result, store, ledger }));
}

describe("F2 — the privileged diff reports only fields that actually changed", () => {
  it("omits an unchanged supervising-doctor list built from two array instances", async () => {
    mocks.changeRole.mockImplementation(
      async (_user: AuthedUser, input: { staff_id: string; role: string }, mode = "execute") =>
        coreResult(input, mode as "preview" | "execute", {
          beforeDoctors: ["00000000-0000-4000-8000-0000000000d1"],
        }),
    );
    const { result } = await preview();
    if (!("preview" in result)) throw new Error("expected a preview");
    expect(
      result.preview.changes.map((change) => change.label),
    ).not.toContain("Supervising doctors");
    expect(result.preview.changes.map((change) => change.label)).toEqual([
      "Staff member",
      "Role",
    ]);
  });

  it("still reports a genuine supervising-doctor change with distinct values", async () => {
    mocks.changeRole.mockImplementation(
      async (_user: AuthedUser, input: { staff_id: string; role: string }, mode = "execute") =>
        coreResult(input, mode as "preview" | "execute", {
          beforeDoctors: ["00000000-0000-4000-8000-0000000000d1"],
          afterDoctors: [
            "00000000-0000-4000-8000-0000000000d1",
            "00000000-0000-4000-8000-0000000000d2",
          ],
        }),
    );
    const { result } = await preview();
    if (!("preview" in result)) throw new Error("expected a preview");
    const row = result.preview.changes.find(
      (change) => change.label === "Supervising doctors",
    );
    expect(row).toBeDefined();
    expect(row?.before).not.toBe(row?.after);
  });

  it("still rejects a fully no-op privileged input via the preview contract", async () => {
    mocks.changeRole.mockImplementation(
      async (_user: AuthedUser, input: { staff_id: string }, mode = "execute") =>
        coreResult({ ...input, role: "receptionist" }, mode as "preview" | "execute"),
    );
    await expect(preview(roleInput("receptionist"))).rejects.toBeInstanceOf(
      ActionPreviewContractError,
    );
  });
});

describe("F3 — the primary-admin rule lives at the Assistant boundary only", () => {
  it("refuses a primary-admin demotion with operation-specific copy, before the core runs", async () => {
    mocks.isPrimaryClinicAdmin.mockResolvedValue(true);
    const { result, ledger } = await preview();
    expect(result).toMatchObject({
      action_denied: true,
      reason: "business_rule_violation",
    });
    expect(mocks.changeRole).not.toHaveBeenCalled();
    expect(ledger.finals.at(-1)?.errorCode).toBe(
      "settings.thePrimaryClinicAdminRoleCannotBeChanged",
    );
  });

  it("does not fire when the requested role keeps the target an admin", async () => {
    mocks.isPrimaryClinicAdmin.mockResolvedValue(true);
    const { result } = await preview(roleInput("admin"));
    // Mirrors the guard the legacy core briefly carried: only a change *away*
    // from admin is protected, so a promotion to admin still previews normally.
    expect(result).toMatchObject({ phase: "preview", risk_class: "privileged" });
    expect(mocks.changeRole).toHaveBeenCalled();
  });

  it("ships operation-specific EN and AR copy for every boundary refusal", () => {
    const keys = [
      "thePrimaryClinicAdminRoleCannotBeChanged",
      "thePrimaryClinicAdminCannotBeDeactivated",
      "thePrimaryClinicAdminCannotBeDeleted",
    ];
    for (const locale of ["en", "ar"]) {
      const catalog = JSON.parse(
        readFileSync(`messages/action-errors/${locale}.json`, "utf8"),
      ) as { settings: Record<string, string> };
      for (const key of keys) {
        expect(catalog.settings[key], `${locale}.${key}`).toBeTruthy();
        // Never the page-permission "cannot be customized" copy, which is what
        // a Deactivate/Delete click used to render.
        expect(catalog.settings[key]).not.toMatch(/customiz|تخصيص/i);
      }
    }
  });
});

describe("F5 — a failed admin notification never relabels a committed mutation", () => {
  async function executeWithNotifier(
    notifier: () => Promise<PrivilegedNotificationResult>,
  ) {
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
      privilegedNotifier: notifier,
    });
    return { executed, ledger };
  }

  it("records allowed/success with real digests and tells the actor it applied", async () => {
    const { executed, ledger } = await executeWithNotifier(async () => ({
      delivered: false,
      reason: "no_active_admin",
    }));

    expect(executed).toMatchObject({
      phase: "execute",
      executed: true,
      notification_delivered: false,
    });
    const mutationReceipt = ledger.finals.find(
      (final) => final.receiptId === ledger.begins[0].id,
    );
    expect(mutationReceipt).toMatchObject({
      authorizationOutcome: "allowed",
      denialReason: null,
      outcome: "success",
      errorCode: null,
      targetRecordIds: [TARGET_ID],
    });
    expect(mutationReceipt?.beforeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(mutationReceipt?.afterDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("surfaces the delivery failure as its own receipt, distinguishable from the mutation", async () => {
    const { ledger } = await executeWithNotifier(async () => ({
      delivered: false,
      reason: "emit_failed",
    }));

    const followUp = ledger.begins.find(
      (begin) => begin.actionId === PRIVILEGED_NOTIFICATION_FAILURE_ACTION_ID,
    );
    expect(followUp).toBeDefined();
    expect(followUp?.actionId).not.toBe("staff.change_role");
    const followUpFinal = ledger.finals.find(
      (final) => final.receiptId === followUp?.id,
    );
    expect(followUpFinal).toMatchObject({
      authorizationOutcome: "allowed",
      outcome: "error",
      errorCode: "privileged_notification_emit_failed",
      targetTable: "notifications",
    });
  });

  it("survives a notifier that throws, still reporting the mutation as applied", async () => {
    const { executed, ledger } = await executeWithNotifier(async () => {
      throw new Error("notification transport exploded");
    });
    expect(executed).toMatchObject({
      executed: true,
      notification_delivered: false,
    });
    expect(
      ledger.finals.find((final) => final.receiptId === ledger.begins[0].id),
    ).toMatchObject({ outcome: "success" });
  });

  it("reports delivery when the notifier succeeds", async () => {
    const { executed } = await executeWithNotifier(async () => ({
      delivered: true,
      recipientCount: 2,
    }));
    expect(executed).toMatchObject({
      executed: true,
      notification_delivered: true,
    });
  });
});

describe("F1 — the assistant E2E specs seed Phase 0b commercial-terms acceptance", () => {
  it.each([
    "tests/e2e/phase5f-privileged-actions.spec.ts",
    "tests/e2e/p4b-assistant.spec.ts",
  ])(
    "%s seeds an accepted ai_commercial_terms row and cleans it up",
    (specPath) => {
      const source = readFileSync(specPath, "utf8");
      // Without this row `effective_ai_feature` is false for every `ai.*` key,
      // the assistant surface renders its upgrade gate, and no composer mounts.
      expect(source).toContain('from("ai_commercial_terms").insert(');
      expect(source).toContain("accepted_at");
      expect(source).toContain("change_reason");
      expect(source).toContain('from("ai_commercial_terms").delete()');
    },
  );
});
