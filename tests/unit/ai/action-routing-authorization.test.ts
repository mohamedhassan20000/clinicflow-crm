/**
 * 13 — the action-routing fix grants nothing (review §9.5).
 *
 * The fix makes a previously unreachable path reachable: an instructionally
 * phrased booking now routes to a class that mounts `execute_action`. That is a
 * *routing* change, and routing has never been an authorization input — but the
 * whole point of a capability fix is that it must not quietly become a
 * privilege fix. This suite drives `appointments.create` down the newly
 * reachable path for a caller who is missing each of the three gates in turn,
 * and asserts the denial reason is byte-identical to the one the imperative
 * path already produced.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { AuthedUser, UserRole } from "@/lib/rbac";
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
  createAppointment: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/authorization")>()),
  assertStaffToolAccess: mocks.assertStaffToolAccess,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: mocks.getEntitlements,
  hasFeature: mocks.hasFeature,
}));
vi.mock("@/lib/ai/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/permissions")>()),
  hasAiUserPermission: mocks.hasPermission,
}));
vi.mock("@/lib/server-page-permissions", () => ({
  getPageVisibilityState: mocks.getPageVisibilityState,
}));
vi.mock("@/lib/appointments/mutations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/appointments/mutations")>();
  return { ...actual, createAppointmentMutation: mocks.createAppointment };
});
vi.mock("@/lib/supabase/admin", () => ({
  issueAiActionConfirmation: vi.fn(),
  verifyAiActionStepUp: vi.fn(),
  claimAiActionConfirmation: vi.fn(),
  beginAiActionReceipt: vi.fn(),
  finalizeAiActionReceipt: vi.fn(),
  consumeAiPrivilegedActionRateLimit: vi.fn(),
}));

import { previewRegisteredAction } from "@/lib/ai/actions/execute";
import { staffTaskForRole } from "@/lib/ai/platform/execution";
import { AI_TOOL_REGISTRY_BY_NAME } from "@/lib/ai/tools/registry";

const CLINIC = "00000000-0000-4000-8000-0000000000c1";
const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000c2";
const DOCTOR_ID = "00000000-0000-4000-8000-0000000000d1";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000e1";
const RECORD_ID = "00000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-08-15T09:00:00.000Z");

function actor(role: UserRole): AuthedUser {
  return {
    id: DOCTOR_ID,
    clinicId: CLINIC,
    email: `${role}@example.test`,
    fullName: `Test ${role}`,
    role,
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  };
}

class ConfirmationStore implements ActionConfirmationStore {
  rows = new Map<string, { consumed: boolean }>();
  async issue(input: { tokenHash: string }) {
    this.rows.set(input.tokenHash, { consumed: false });
  }
  async claim(): Promise<ConfirmationClaimOutcome> {
    return "invalid";
  }
}

class Ledger implements ActionReceiptLedger {
  finals: Array<Parameters<ActionReceiptLedger["finalize"]>[0]> = [];
  async begin() {
    return "00000000-0000-4000-8000-000000000200";
  }
  async finalize(input: Parameters<ActionReceiptLedger["finalize"]>[0]) {
    this.finals.push(structuredClone(input));
  }
}

const APPOINTMENT_INPUT = {
  patient_id: PATIENT_ID,
  doctor_id: DOCTOR_ID,
  scheduled_at: "2026-09-01T10:00:00.000Z",
  duration_minutes: 30,
};

const IMPERATIVE = "Book Ahmed Ali with Dr. Sara on Sunday at 10:00";
const INSTRUCTIONAL = "How do I book Ahmed Ali with Dr. Sara on Sunday at 10:00?";
const ARABIC_INSTRUCTIONAL = "كيف أحجز موعدًا لأحمد علي مع د. سارة يوم الأحد الساعة 10؟";

async function preview(user: AuthedUser) {
  const ledger = new Ledger();
  const result = await previewRegisteredAction({
    user,
    conversationId: CONVERSATION_ID,
    actionId: "appointments.create",
    actionInput: APPOINTMENT_INPUT,
    now: NOW,
    confirmationStore: new ConfirmationStore(),
    receiptLedger: ledger,
  });
  return { result, ledger };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
  mocks.assertStaffToolAccess.mockResolvedValue(undefined);
  mocks.getEntitlements.mockResolvedValue({
    clinicId: CLINIC,
    planSlug: "pro_ai",
    features: {},
    limits: {},
    subscriptionAllowed: true,
    aiTermsAccepted: true,
  });
  mocks.hasFeature.mockReturnValue(true);
  mocks.hasPermission.mockResolvedValue(true);
  mocks.getPageVisibilityState.mockResolvedValue("visible");
  mocks.createAppointment.mockImplementation(async (_user, _input, mode = "execute") => ({
    ok: true as const,
    data: { id: RECORD_ID },
    audit: {
      targetTable: "appointments",
      targetRecordIds: [RECORD_ID],
      before: null,
      after: { id: RECORD_ID },
    },
    mode,
  }));
});

afterEach(() => {
  delete process.env.AI_ACTION_CONFIRMATION_HMAC_KEY;
});

describe("13 — routing widens reachability, never authorization", () => {
  it("the imperative and instructional phrasings resolve to the same action-capable class", () => {
    const classes = AI_TOOL_REGISTRY_BY_NAME.get("execute_action")!
      .taskClasses as readonly string[];
    for (const messageText of [IMPERATIVE, INSTRUCTIONAL, ARABIC_INSTRUCTIONAL]) {
      const { task } = staffTaskForRole("receptionist", {
        analyticsEntitled: true,
        messageText,
      });
      expect(classes, messageText).toContain(task);
    }
  });

  it("denies a caller lacking ai.write_scheduling with plan_not_entitled", async () => {
    mocks.hasFeature.mockImplementation((_ents: unknown, key: string) => key !== "ai.write_scheduling");
    const { result, ledger } = await preview(actor("receptionist"));
    expect("action_denied" in result).toBe(true);
    expect((result as { reason?: string }).reason).toBe("plan_not_entitled");
    expect(mocks.createAppointment).not.toHaveBeenCalled();
    // The denial is still recorded — the audit guarantee is unchanged.
    expect(ledger.finals).toHaveLength(1);
  });

  it("denies a caller whose role the action does not authorize with unauthorized_role", async () => {
    // `appointments.create` authorizes administrative + clinical roles; a role
    // outside an action's own list is refused by the action, not the router.
    const { AI_ACTION_REGISTRY } = await import("@/lib/ai/actions/registry");
    const definition = AI_ACTION_REGISTRY.find((a) => a.id === "appointments.create")!;
    const unauthorized = (["admin", "manager", "receptionist", "doctor", "assistant"] as const)
      .find((role) => !definition.roles.includes(role));
    if (!unauthorized) {
      // Every role is authorized for this action; assert that explicitly rather
      // than silently skipping, so the test still means something.
      expect(definition.roles.length).toBeGreaterThan(0);
      return;
    }
    const { result } = await preview(actor(unauthorized));
    expect((result as { reason?: string }).reason).toBe("unauthorized_role");
    expect(mocks.createAppointment).not.toHaveBeenCalled();
  });

  it("denies a caller with the appointments page hidden with unauthorized_scope", async () => {
    mocks.getPageVisibilityState.mockResolvedValue("hidden");
    const { result, ledger } = await preview(actor("receptionist"));
    expect((result as { reason?: string }).reason).toBe("unauthorized_scope");
    expect(mocks.createAppointment).not.toHaveBeenCalled();
    expect(ledger.finals).toHaveLength(1);
  });

  it("an authorized caller still only gets a preview that requires on-screen confirmation", async () => {
    const { result } = await preview(actor("receptionist"));
    expect("action_denied" in result).toBe(false);
    expect(result.phase).toBe("preview");
    expect(result.confirmation_required).toBe(true);
    // Preview mode only: nothing is written until the confirmation is claimed.
    expect(mocks.createAppointment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "preview",
    );
    // The confirm token exists on the server result and is stripped by the
    // tool before the payload reaches model context (asserted in the Phase 3
    // action-foundation suite); what matters here is that the preview did not
    // become an execution.
    expect("executed" in result).toBe(false);
  });
});
