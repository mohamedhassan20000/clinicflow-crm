/**
 * Final comprehensive review — B-2 regression suite.
 *
 * The defect: `execute_action` and `describe_action` declared a hand-written
 * `ADMINISTRATIVE` role list. That list was correct in Phase 3, when no action
 * authorized a doctor or an assistant, and was never widened when Phases 5c and
 * 6 registered 21 doctor-authorized and 22 assistant-authorized actions. The
 * result was that the *only* tool able to invoke any registered write was
 * unmounted for the two roles that own the clinical-authoring surface — an
 * AI-local restriction the application itself does not have, which is exactly
 * the class of defect plan §5 exists to forbid.
 *
 * The fix derives the mount from `AI_ACTION_REGISTRY` instead of listing it.
 * This suite pins the resulting invariant in both directions:
 *
 *   1. **Agreement.** For all 5 roles × all registered actions, an action is
 *      reachable through the mounted tool set *iff* `assertActionAccess` allows
 *      it. The tool mount and the action registry cannot disagree.
 *   2. **No widening.** Mounting the tool grants nothing. Each role reaches only
 *      the actions its own definitions authorize; a doctor and an assistant are
 *      refused for actions outside their role list, at preview and at execute,
 *      with a receipt written for the denial.
 *   3. **End-to-end.** A doctor completes `prescriptions.create_draft` through
 *      preview → confirm, and an assistant completes `appointments.create`, each
 *      with receipts for both phases — proving the widened mount reaches a real
 *      write and not just a description of one.
 *   4. **The advisory follows the mount.** `resourceExportSuggestion` never
 *      names `documents.issue` to a caller who cannot mount `execute_action`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
  createPrescription: vi.fn(),
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
vi.mock("@/lib/clinical/mutations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clinical/mutations")>();
  return { ...actual, createPrescriptionMutation: mocks.createPrescription };
});
vi.mock("@/lib/appointments/mutations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/appointments/mutations")>();
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

import {
  describeAuthorizedActions,
  executeRegisteredAction,
  previewRegisteredAction,
} from "@/lib/ai/actions/execute";
import { AI_ACTION_REGISTRY } from "@/lib/ai/actions/registry";
import {
  ACTION_CAPABLE_ROLES,
  AI_TOOL_REGISTRY_BY_NAME,
  roleMountsActionTools,
} from "@/lib/ai/tools/registry";
import { maximalStaffTools, ALL_STAFF_ROLES } from "@/lib/ai/eval/authorized-tools";
import { INJECTION_CASES } from "@/lib/ai/eval/injection-corpus";

const CLINIC = "00000000-0000-4000-8000-0000000000c1";
const CONVERSATION_ID = "00000000-0000-4000-8000-0000000000c2";
const DOCTOR_ID = "00000000-0000-4000-8000-0000000000d1";
const PATIENT_ID = "00000000-0000-4000-8000-0000000000e1";
const RECORD_ID = "00000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-08-15T09:00:00.000Z");

function actor(role: UserRole, id = DOCTOR_ID): AuthedUser {
  return {
    id,
    clinicId: CLINIC,
    email: `${role}@example.test`,
    fullName: `Test ${role}`,
    role,
    avatarUrl: null,
    departmentId: null,
    mustChangePassword: false,
  };
}

// ---------------------------------------------------------------------------
// Confirmation store / receipt ledger doubles (same shape as the Phase 5f
// suite: real pipeline, in-memory control plane).
// ---------------------------------------------------------------------------

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

class ConfirmationStore implements ActionConfirmationStore {
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
    if (!row) return "invalid";
    if (row.consumed) return "replayed";
    if (new Date(row.expiresAt) <= new Date(input.consumedAt)) return "expired";
    if (
      row.clinicId !== input.clinicId ||
      row.actorId !== input.actorId ||
      row.conversationId !== input.conversationId ||
      row.actionId !== input.actionId ||
      row.inputDigest !== input.inputDigest
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
    const id = `00000000-0000-4000-8000-${String(this.begins.length + 200).padStart(12, "0")}`;
    this.begins.push({ ...input, id });
    return id;
  }
  async finalize(input: Parameters<ActionReceiptLedger["finalize"]>[0]) {
    this.finals.push(structuredClone(input));
  }
}

function domainOk(mode: "preview" | "execute") {
  return {
    ok: true as const,
    data: { id: RECORD_ID, status: "draft" as const },
    audit: {
      targetTable: "prescriptions",
      targetRecordIds: [RECORD_ID],
      before: null,
      after: { id: RECORD_ID, status: "draft" },
    },
    mode,
  };
}

const PRESCRIPTION_INPUT = {
  responsible_doctor_id: DOCTOR_ID,
  patient_id: PATIENT_ID,
  medications: [{ drug_name: "Amoxicillin", dose: "500mg" }],
};

const APPOINTMENT_INPUT = {
  patient_id: PATIENT_ID,
  doctor_id: DOCTOR_ID,
  scheduled_at: "2026-09-01T10:00:00.000Z",
  duration_minutes: 30,
};

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
  mocks.createPrescription.mockImplementation(async (_user, _input, mode = "execute") =>
    domainOk(mode),
  );
  mocks.createAppointment.mockImplementation(async (_user, _input, mode = "execute") => ({
    ...domainOk(mode),
    audit: {
      targetTable: "appointments",
      targetRecordIds: [RECORD_ID],
      before: null,
      after: { id: RECORD_ID, patient_id: PATIENT_ID, doctor_id: DOCTOR_ID },
    },
  }));
});

afterEach(() => {
  delete process.env.AI_ACTION_CONFIRMATION_HMAC_KEY;
});

// ---------------------------------------------------------------------------
// 1 · Agreement between the tool mount and the action registry
// ---------------------------------------------------------------------------

describe("B-2 · the action tool mount and the action registry cannot disagree", () => {
  it("mounts the action tools for exactly the roles the registry authorizes an action for", () => {
    const derived = ALL_STAFF_ROLES.filter((role) =>
      AI_ACTION_REGISTRY.some((action) => action.roles.includes(role)),
    );
    expect([...ACTION_CAPABLE_ROLES].sort()).toEqual([...derived].sort());
    // The regression this replaces: a list that named only the three
    // administrative roles while the registry authorized five.
    expect(ACTION_CAPABLE_ROLES).toContain("doctor");
    expect(ACTION_CAPABLE_ROLES).toContain("assistant");

    // Both generic action tools must carry that derived list *by reference*, so
    // a future edit that re-hard-codes either one fails here rather than
    // silently removing a role's entire write surface again.
    for (const name of ["execute_action", "describe_action"] as const) {
      const definition = AI_TOOL_REGISTRY_BY_NAME.get(name);
      expect(definition, name).toBeDefined();
      expect(definition!.roles, name).toBe(ACTION_CAPABLE_ROLES);
    }
  });

  it.each(ALL_STAFF_ROLES.map((role) => [role] as const))(
    "%s: an action is reachable through the mount iff assertActionAccess allows it",
    async (role) => {
      const mounted = maximalStaffTools(role, { financial: true });
      const authorized = new Set(
        (await describeAuthorizedActions(actor(role))).map((d) => d.id),
      );

      // The mount is the gate the *tool* provides; assertActionAccess is the
      // gate the *action* provides. Reachability is the conjunction, and the
      // invariant is that the conjunction never loses an authorized action.
      for (const action of AI_ACTION_REGISTRY) {
        const allowedByAction = authorized.has(action.id);
        const reachable = mounted.has("execute_action") && allowedByAction;
        expect(reachable, `${role} · ${action.id}`).toBe(allowedByAction);
      }

      // And the converse: a role with no authorized action at all must not
      // mount the tools, so no role is ever shown an empty action surface.
      expect(mounted.has("execute_action"), role).toBe(authorized.size > 0);
      expect(mounted.has("describe_action"), role).toBe(authorized.size > 0);
      expect(roleMountsActionTools(role), role).toBe(authorized.size > 0);
    },
  );

  it("gives doctors and assistants the clinical-authoring surface the registry declares", async () => {
    const doctor = new Set(
      (await describeAuthorizedActions(actor("doctor"))).map((d) => d.id),
    );
    const assistant = new Set(
      (await describeAuthorizedActions(actor("assistant"))).map((d) => d.id),
    );

    for (const id of [
      "prescriptions.create_draft",
      "prescriptions.finalize",
      "lab_requests.create_draft",
      "sick_leaves.create_draft",
      "documents.issue",
      "documents.reprint",
    ]) {
      expect(doctor, `doctor · ${id}`).toContain(id);
      expect(assistant, `assistant · ${id}`).toContain(id);
    }
    expect(doctor).toContain("medical_notes.create");
    expect(doctor).toContain("appointments.start_session");
    expect(assistant).toContain("appointments.create");
    expect(assistant).toContain("followups.record");

    // Negative: neither role reaches an administrative or privileged action.
    for (const id of [
      "staff.change_role",
      "staff.permanent_delete",
      "assistant.reference_check",
      "appointments.send_reminders",
      "invoices.send_reminders",
    ]) {
      expect(doctor, `doctor · ${id}`).not.toContain(id);
      expect(assistant, `assistant · ${id}`).not.toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// 2 + 3 · Real preview → confirm through the widened mount, and its refusals
// ---------------------------------------------------------------------------

async function preview(options: {
  user: AuthedUser;
  actionId: string;
  actionInput: unknown;
  store?: ConfirmationStore;
  ledger?: Ledger;
}) {
  const store = options.store ?? new ConfirmationStore();
  const ledger = options.ledger ?? new Ledger();
  const result = await previewRegisteredAction({
    user: options.user,
    conversationId: CONVERSATION_ID,
    actionId: options.actionId,
    actionInput: options.actionInput,
    now: NOW,
    confirmationStore: store,
    receiptLedger: ledger,
  });
  return { result, store, ledger };
}

describe("B-2 · a doctor and an assistant complete a real write end-to-end", () => {
  it("lets a doctor issue prescriptions.create_draft through preview → confirm with receipts for both phases", async () => {
    const doctor = actor("doctor");
    const { result, store, ledger } = await preview({
      user: doctor,
      actionId: "prescriptions.create_draft",
      actionInput: PRESCRIPTION_INPUT,
    });

    expect(result).toMatchObject({
      action_id: "prescriptions.create_draft",
      phase: "preview",
      confirmation_required: true,
    });
    const token = (result as { confirm_token: string }).confirm_token;
    expect(typeof token).toBe("string");
    // The preview must not have run the write.
    expect(mocks.createPrescription).toHaveBeenCalledWith(
      doctor,
      expect.anything(),
      "preview",
    );

    const executed = await executeRegisteredAction({
      user: doctor,
      conversationId: CONVERSATION_ID,
      actionId: "prescriptions.create_draft",
      actionInput:
        (result as { action_input?: unknown }).action_input ?? PRESCRIPTION_INPUT,
      confirmToken: token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });

    expect(executed).toMatchObject({
      action_id: "prescriptions.create_draft",
      phase: "execute",
      executed: true,
    });
    expect(mocks.createPrescription).toHaveBeenCalledWith(
      doctor,
      expect.anything(),
      "execute",
    );

    const phases = ledger.begins.map((entry) => entry.phase);
    expect(phases).toContain("preview");
    expect(phases).toContain("execute");
    expect(
      ledger.finals.filter((entry) => entry.authorizationOutcome === "allowed"),
    ).toHaveLength(2);
  });

  it("lets an assistant create an appointment through the same pipeline", async () => {
    const assistant = actor("assistant");
    const { result, store, ledger } = await preview({
      user: assistant,
      actionId: "appointments.create",
      actionInput: APPOINTMENT_INPUT,
    });
    expect(result).toMatchObject({ phase: "preview", confirmation_required: true });

    const executed = await executeRegisteredAction({
      user: assistant,
      conversationId: CONVERSATION_ID,
      actionId: "appointments.create",
      actionInput:
        (result as { action_input?: unknown }).action_input ?? APPOINTMENT_INPUT,
      confirmToken: (result as { confirm_token: string }).confirm_token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });
    expect(executed).toMatchObject({ phase: "execute", executed: true });
    expect(ledger.begins.map((entry) => entry.phase).sort()).toEqual([
      "execute",
      "preview",
    ]);
  });
});

describe("B-2 · widening the mount did not widen authorization", () => {
  it.each([
    ["doctor", "appointments.send_reminders"],
    ["doctor", "staff.change_role"],
    ["doctor", "assistant.reference_check"],
    ["assistant", "invoices.send_reminders"],
    ["assistant", "staff.change_role"],
    ["assistant", "medical_notes.create"],
  ] as const)(
    "%s is refused %s at preview with a denial receipt",
    async (role, actionId) => {
      const { result, ledger } = await preview({
        user: actor(role),
        actionId,
        actionInput: { label: "probe" },
      });
      expect(result).toMatchObject({
        action_id: actionId,
        action_denied: true,
        reason: "unauthorized_role",
      });
      // Denials are ledgered exactly like allows — §12's requirement, and the
      // reason a widened mount stays auditable.
      expect(ledger.finals).toHaveLength(1);
      expect(ledger.finals[0]).toMatchObject({
        authorizationOutcome: "denied",
        denialReason: "unauthorized_role",
      });
    },
  );

  it.each(
    INJECTION_CASES.filter((entry) => entry.forbiddenAction).map(
      (entry) => [entry.id, entry.role ?? "doctor", entry.forbiddenAction!] as const,
    ),
  )(
    "%s: the adversarial corpus's forbidden action is refused for %s through the real pipeline",
    async (_id, role, actionId) => {
      // Behavioural counterpart to the corpus's structural claim. Those three
      // prompt-injection cases used to prove containment by the doctor not
      // mounting `execute_action` at all; with the mount restored, the proof
      // has to be that the pipeline itself refuses. Driven off the corpus so
      // the two cannot drift: adding a `forbiddenAction` case adds a run here.
      const { result } = await preview({
        user: actor(role as UserRole),
        actionId,
        actionInput: { label: "probe" },
      });
      expect(result).toMatchObject({
        action_denied: true,
        confirmation_required: false,
        reason: "unauthorized_role",
      });
      // No confirm token is minted for a denial, so nothing exists to replay.
      expect(result).not.toHaveProperty("confirm_token");
    },
  );

  it("refuses at execute too, even holding a token, when the role is not authorized", async () => {
    // Mint a legitimate admin token, then try to spend it as a doctor. The
    // token binds the actor, so this is refused on the confirmation before the
    // role check is even reached — and the role check would refuse it anyway.
    const admin = actor("admin", "00000000-0000-4000-8000-0000000000a1");
    const { result, store, ledger } = await preview({
      user: admin,
      actionId: "assistant.reference_check",
      actionInput: { label: "probe" },
    });
    const token = (result as { confirm_token: string }).confirm_token;

    const denied = await executeRegisteredAction({
      user: actor("doctor"),
      conversationId: CONVERSATION_ID,
      actionId: "assistant.reference_check",
      actionInput: { label: "probe" },
      confirmToken: token,
      now: NOW,
      confirmationStore: store,
      receiptLedger: ledger,
    });
    expect(denied).toMatchObject({ action_denied: true });
    expect((denied as { reason: string }).reason).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// 4 · The export advisory never names an action the caller cannot mount
// ---------------------------------------------------------------------------

describe("B-2 · the export hatch cannot advertise an unmountable action", () => {
  it("returns null for a role that cannot mount execute_action", async () => {
    vi.resetModules();
    vi.doMock("@/lib/ai/tools/registry", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@/lib/ai/tools/registry")>()),
      // Simulate the pre-fix world (and any future regression) in which the
      // caller's role holds no action mount at all. The advisory must go quiet
      // rather than tell the model to "issue it with the documents.issue
      // action" — the exact prompt/capability drift §18 names.
      roleMountsActionTools: () => false,
    }));
    vi.doMock("@/lib/documents/module", () => ({
      getAccessibleDocumentTypeCodes: () => ["PATIENT_LIST_REPORT"],
    }));
    vi.doMock("@/lib/documents/mutations", () => ({
      assertDocumentTypeAccess: async () => ({ ok: true }),
    }));
    vi.doMock("@/lib/entitlements", () => ({
      getEntitlements: async () => ({ features: {}, subscriptionAllowed: true }),
      hasFeature: () => true,
    }));

    const { resourceExportSuggestion } = await import(
      "@/lib/ai/resources/export-hatch"
    );
    expect(await resourceExportSuggestion(actor("doctor"), "patients")).toBeNull();
    vi.doUnmock("@/lib/ai/tools/registry");
    vi.resetModules();
  });

  it("offers the suggestion to a doctor now that the mount exists", async () => {
    vi.resetModules();
    vi.doMock("@/lib/documents/module", () => ({
      getAccessibleDocumentTypeCodes: () => ["PATIENT_LIST_REPORT"],
    }));
    vi.doMock("@/lib/documents/mutations", () => ({
      assertDocumentTypeAccess: async () => ({ ok: true }),
    }));
    vi.doMock("@/lib/entitlements", () => ({
      getEntitlements: async () => ({ features: {}, subscriptionAllowed: true }),
      hasFeature: () => true,
    }));

    const { resourceExportSuggestion } = await import(
      "@/lib/ai/resources/export-hatch"
    );
    const suggestion = await resourceExportSuggestion(actor("doctor"), "patients");
    expect(suggestion).toMatchObject({
      document_type: "PATIENT_LIST_REPORT",
      action_id: "documents.issue",
    });
    vi.resetModules();
  });
});
