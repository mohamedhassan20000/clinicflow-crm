import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedUser } from "@/lib/rbac";
import type {
  ActionConfirmationStore,
  ActionReceiptLedger,
  ConfirmationClaimOutcome,
} from "@/lib/ai/actions/types";
import { assertActionPreviewContract } from "@/lib/ai/actions/types";

const auth = vi.hoisted(() => ({
  assertStaffToolAccess: vi.fn(),
  getEntitlements: vi.fn(),
  hasFeature: vi.fn(),
  hasPermission: vi.fn(),
  pageVisibility: vi.fn(),
}));

vi.mock("@/lib/ai/authorization", () => ({
  assertStaffToolAccess: auth.assertStaffToolAccess,
}));
vi.mock("@/lib/entitlements", () => ({
  getEntitlements: auth.getEntitlements,
  hasFeature: auth.hasFeature,
}));
vi.mock("@/lib/ai/permissions", () => ({
  hasAiUserPermission: auth.hasPermission,
}));
vi.mock("@/lib/server-page-permissions", () => ({
  getPageVisibilityState: auth.pageVisibility,
}));

import {
  APPOINTMENT_ACTION_DEFINITIONS,
  appointmentIdentifier,
} from "@/lib/ai/actions/definitions/appointments";
import { BILLING_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/billing";
import { CLINICAL_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/clinical";
import { FOLLOWUP_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/followups";
import { PATIENT_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/patients";
import { SETTINGS_ACTION_DEFINITIONS } from "@/lib/ai/actions/definitions/settings";
import { executeRegisteredAction } from "@/lib/ai/actions/execute";
import { previewRegisteredAction } from "@/lib/ai/actions/execute";
import { AI_ACTION_REGISTRY } from "@/lib/ai/actions/registry";
import { CLINICAL_PREPARER_ROLES } from "@/actions/clinical/_shared";
import { ActionBusinessRuleError } from "@/lib/ai/actions/errors";
import { CLINICAL_MUTATION_ROLES } from "@/lib/clinical/mutations";
import { DomainMutationAuthorizationError } from "@/lib/domain-mutations";

const UUID = "00000000-0000-4000-8000-000000000010";
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

const PHASE5_ACTIONS = [
  ...APPOINTMENT_ACTION_DEFINITIONS,
  ...FOLLOWUP_ACTION_DEFINITIONS,
  ...PATIENT_ACTION_DEFINITIONS,
  ...CLINICAL_ACTION_DEFINITIONS,
  ...BILLING_ACTION_DEFINITIONS,
  ...SETTINGS_ACTION_DEFINITIONS,
];

function byId(id: string) {
  const definition = PHASE5_ACTIONS.find((action) => action.id === id);
  if (!definition) throw new Error(`Missing Phase 5 action ${id}`);
  return definition;
}

class NeverClaimStore implements ActionConfirmationStore {
  async issue() {}
  async claim(): Promise<ConfirmationClaimOutcome> {
    return "invalid";
  }
}

class MemoryLedger implements ActionReceiptLedger {
  begins: Parameters<ActionReceiptLedger["begin"]>[0][] = [];
  finals: Parameters<ActionReceiptLedger["finalize"]>[0][] = [];
  async begin(input: Parameters<ActionReceiptLedger["begin"]>[0]) {
    this.begins.push(input);
    return "00000000-0000-4000-8000-000000000099";
  }
  async finalize(input: Parameters<ActionReceiptLedger["finalize"]>[0]) {
    this.finals.push(input);
  }
}

function validDestructiveInput(actionId: string) {
  if (actionId === "followups.delete") return { followup_id: UUID };
  if (actionId.startsWith("patients.")) return { patient_id: UUID };
  if (actionId === "medical_notes.delete") return { note_id: UUID };
  if (actionId === "package_templates.delete") return { template_id: UUID };
  if (actionId.startsWith("billing.")) return { appointment_id: UUID };
  if (actionId.startsWith("appointments.")) return { appointment_id: UUID };
  return { id: UUID };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 8).toString("base64");
  auth.assertStaffToolAccess.mockResolvedValue(undefined);
  auth.getEntitlements.mockResolvedValue({
    subscriptionAllowed: true,
    planSlug: "pro_ai",
    features: {},
    limits: {},
  });
  auth.hasFeature.mockReturnValue(true);
  auth.hasPermission.mockResolvedValue(true);
  auth.pageVisibility.mockResolvedValue("visible");
});

describe("Phase 5 domain write registry", () => {
  it("registers all 74 5a-5e actions exactly once with an entitled write feature", () => {
    expect(PHASE5_ACTIONS).toHaveLength(74);
    expect(new Set(PHASE5_ACTIONS.map((action) => action.id)).size).toBe(74);
    expect(new Set(AI_ACTION_REGISTRY.map((action) => action.id)).size).toBe(
      AI_ACTION_REGISTRY.length,
    );
    for (const action of PHASE5_ACTIONS) {
      expect(action.requiredFeatures).toHaveLength(1);
      expect(action.requiredFeatures[0]).toMatch(/^ai\.write_/);
      expect(action.roles.length).toBeGreaterThan(0);
    }
  });

  it("does not register Phase 5f or out-of-scope platform/commercial mutations", () => {
    const ids = PHASE5_ACTIONS.map((action) => action.id);
    expect(ids).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/permission|change_role|set_role|reset_password|staff\.deactivate|staff\.delete/),
      expect.stringMatching(/subscription|plan|operator|platform/),
    ]));
    expect(PHASE5_ACTIONS.some((action) => action.risk === "privileged")).toBe(false);
    expect(PHASE5_ACTIONS.flatMap((action) => action.requiredFeatures)).not.toContain(
      "ai.write_privileged",
    );

    const staffCreateInput = {
      full_name: "Test Staff",
      email: "staff@example.com",
      department_id: null,
      phone: null,
      supervising_doctor_ids: [],
    };
    expect(byId("staff.create").inputSchema.safeParse({
      ...staffCreateInput,
      role: "admin",
    }).success).toBe(false);
    expect(byId("staff.create").inputSchema.safeParse({
      ...staffCreateInput,
      role: "receptionist",
    }).success).toBe(true);
    expect(byId("staff.create").inputSchema.safeParse({
      ...staffCreateInput,
      role: "manager",
    }).success).toBe(false);
    expect(byId("staff.create").inputSchema.safeParse({
      ...staffCreateInput,
      role: "receptionist",
      temporary_password: "ModelInvented1",
    }).success).toBe(false);
  });
});

describe("Phase 5 extraction and business-rule parity", () => {
  it("keeps every function declaration exported by a use-server action module async", () => {
    function actionFiles(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory()
          ? actionFiles(path)
          : entry.isFile() && entry.name.endsWith(".ts")
            ? [path]
            : [];
      });
    }
    for (const path of actionFiles(resolve("actions"))) {
      const source = readFileSync(path, "utf8");
      if (!/^\s*["']use server["'];/m.test(source)) continue;
      expect(
        source.match(/export\s+function\s+[A-Za-z_$][\w$]*\s*\(/g) ?? [],
        path,
      ).toEqual([]);
    }
  });

  it("removes orphaned legacy modules and does not export superseded mutation copies", () => {
    expect(existsSync(resolve("actions/patient-packages-legacy.ts"))).toBe(false);
    expect(existsSync(resolve("actions/package-templates-legacy.ts"))).toBe(false);
    const legacyFiles = [
      "actions/appointments-legacy.ts",
      "actions/patients-legacy.ts",
      "actions/settings-legacy.ts",
      "actions/clinical/prescriptions-legacy.ts",
      "actions/clinical/lab-requests-legacy.ts",
      "actions/clinical/sick-leaves-legacy.ts",
    ];
    const superseded = [
      "createAppointment", "replaceAppointment", "updateAppointmentStatus",
      "softDeleteAppointment", "restoreAppointment", "undoAppointmentStatus",
      "arriveAppointment", "startAppointmentSession", "permanentDeleteAppointment",
      "confirmAndDisplaceConflicts", "dismissDisplacedAppointment",
      "createPatient", "updatePatient", "softDeletePatient", "restorePatient",
      "archivePatient", "addMedicalNote", "updateMedicalNote", "deleteMedicalNote",
      "restoreMedicalNote", "addPatientDeposit", "settleOutstanding",
      "createStaff", "updateStaffProfileSection", "createDepartment", "updateDepartment",
      "toggleDepartmentActive", "softDeleteDepartment", "restoreDepartment",
      "permanentDeleteDepartment", "createInsurance", "updateInsurance",
      "toggleInsuranceActive", "softDeleteInsurance", "restoreInsurance",
      "permanentDeleteInsurance", "updateClinic", "updateReminderSettings",
      "updateInvoiceFollowupSettings", "createService", "updateService",
      "softDeleteService", "restoreService", "deleteService", "toggleServiceActive",
      "upsertClinicWorkingHours", "upsertStaffSchedule", "createPrescriptionDraft",
      "updatePrescriptionDraft", "finalizePrescription", "voidPrescription",
      "createLabRequestDraft", "updateLabRequestDraft", "finalizeLabRequest",
      "voidLabRequest", "createSickLeaveDraft", "updateSickLeaveDraft",
      "finalizeSickLeave", "voidSickLeave",
    ];
    for (const file of legacyFiles) {
      const source = readFileSync(resolve(file), "utf8");
      for (const name of superseded) {
        expect(source, `${file} must not export ${name}`).not.toMatch(
          new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`),
        );
      }
    }
  });

  it("derives every core invocation from the real registered definition", async () => {
    for (const action of PHASE5_ACTIONS) {
      const role = action.roles[0];
      await expect(
        action.previewValidated({ ...USER, role }, null),
        action.id,
      ).rejects.toBeInstanceOf(ActionBusinessRuleError);
    }

    const roleNegativeControl = { ...USER, role: "assistant" as const };
    await expect(
      byId("clinic.update_profile").previewValidated(
        roleNegativeControl,
        null,
      ),
    ).rejects.toBeInstanceOf(DomainMutationAuthorizationError);
  });

  it("enforces the registered role matrix before schema or core execution", async () => {
    const roles = ["admin", "manager", "receptionist", "doctor", "assistant"] as const;
    for (const action of PHASE5_ACTIONS) {
      const deniedRole = roles.find((role) => !action.roles.includes(role));
      if (!deniedRole) continue;
      const ledger = new MemoryLedger();
      const result = await previewRegisteredAction({
        user: { ...USER, role: deniedRole },
        conversationId: CONVERSATION_ID,
        actionId: action.id,
        actionInput: {},
        confirmationStore: new NeverClaimStore(),
        receiptLedger: ledger,
      });
      expect(result, action.id).toMatchObject({
        action_denied: true,
        reason: "unauthorized_role",
      });
      expect(ledger.finals[0], action.id).toMatchObject({
        authorizationOutcome: "denied",
        denialReason: "unauthorized_role",
      });
    }
  });

  it("matches every registered role to the authorization enforced by the real core", async () => {
    const roles = ["admin", "manager", "receptionist", "doctor", "assistant"] as const;
    for (const action of PHASE5_ACTIONS) {
      for (const role of roles) {
        let thrown: unknown;
        try {
          await action.previewValidated({ ...USER, role }, null);
        } catch (error) {
          thrown = error;
        }
        expect(
          thrown instanceof DomainMutationAuthorizationError,
          `${action.id} must ${action.roles.includes(role) ? "allow" : "deny"} ${role} in both the registry and its core`,
        ).toBe(!action.roles.includes(role));
      }
    }
  });

  it("keeps clinical domain roles identical to the application authorization source", () => {
    expect(new Set(CLINICAL_MUTATION_ROLES)).toEqual(
      new Set(CLINICAL_PREPARER_ROLES),
    );
  });

  it("keeps public mutation adapters free of direct database writes", () => {
    const adapters = [
      "actions/appointments.ts", "actions/followups.ts", "actions/patients.ts",
      "actions/clinical/prescriptions.ts", "actions/clinical/lab-requests.ts",
      "actions/clinical/sick-leaves.ts", "actions/patient-packages.ts",
      "actions/package-templates.ts", "actions/settings.ts",
    ];
    for (const path of adapters) {
      const source = readFileSync(resolve(path), "utf8");
      expect(source, path).not.toContain(".from(");
      expect(source, path).not.toContain("createClient(");
    }
  });

});

describe("Phase 5 confirmation and audit regression", () => {
  it("enforces the §11 record-identifying contract registry-wide", () => {
    const guarded = AI_ACTION_REGISTRY.filter(
      (action) => action.risk === "destructive" || action.risk === "bulk",
    );
    expect(guarded.length).toBeGreaterThan(0);
    for (const action of guarded) {
      expect(action.previewContract, action.id).toBe("record_identifying");
    }

    expect(() =>
      assertActionPreviewContract("destructive", {
        title: "Delete patient",
        summary: "Delete",
        changes: [{ label: "is_deleted", before: false, after: true }],
      }),
    ).toThrow(/identify the exact target record/i);
    expect(() =>
      assertActionPreviewContract("bulk", {
        title: "Bulk",
        summary: "Bulk",
        changes: [
          {
            label: "record",
            before: null,
            after: '{"id":"opaque"}',
            identifiesRecord: true,
          },
        ],
      }),
    ).toThrow(/may not render JSON/i);
  });

  it("classifies multi-record displacement as bulk and renders named appointment identifiers", () => {
    expect(byId("appointments.confirm_and_displace").risk).toBe("bulk");
    const label = appointmentIdentifier({
      id: UUID,
      scheduled_at: "2026-08-20T10:00:00.000Z",
      patients: { full_name: "Maya Patient" },
      profiles: { full_name: "Dr. Deniz" },
    });
    expect(label).toContain("Maya Patient");
    expect(label).toContain("Dr. Deniz");
    expect(label).toContain("2026-08-20T10:00:00.000Z");
    expect(label).not.toMatch(/^\{/);
  });

  it("refuses every destructive Phase 5 action before domain execution without a valid token", async () => {
    const destructive = PHASE5_ACTIONS.filter((action) => action.risk === "destructive");
    expect(destructive.length).toBeGreaterThan(0);
    for (const action of destructive) {
      const ledger = new MemoryLedger();
      const result = await executeRegisteredAction({
        user: USER,
        conversationId: CONVERSATION_ID,
        actionId: action.id,
        actionInput: validDestructiveInput(action.id),
        confirmToken: "not-a-server-token",
        confirmationStore: new NeverClaimStore(),
        receiptLedger: ledger,
      });
      expect(result).toMatchObject({
        action_id: action.id,
        action_denied: true,
        confirmation_required: false,
        reason: "confirmation_invalid",
      });
      expect(ledger.begins).toHaveLength(1);
      expect(ledger.finals).toHaveLength(1);
      expect(ledger.finals[0]).toMatchObject({
        authorizationOutcome: "denied",
        denialReason: "confirmation_invalid",
        outcome: "error",
      });
    }
  });
});
