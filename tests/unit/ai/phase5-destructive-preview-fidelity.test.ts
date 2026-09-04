import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerActionMocks } from "../helpers/server-action-mocks";
import type {
  ActionConfirmationStore,
  ActionReceiptLedger,
  ConfirmationClaimOutcome,
} from "@/lib/ai/actions/types";
import type { AuthedUser } from "@/lib/rbac";

const PATIENT_ID = "00000000-0000-4000-8000-000000000010";
const APPOINTMENT_ID = "00000000-0000-4000-8000-000000000011";
const CLINIC_ID = "00000000-0000-4000-8000-000000000012";
const USER_ID = "00000000-0000-4000-8000-000000000013";
const CONVERSATION_ID = "00000000-0000-4000-8000-000000000014";

const USER: AuthedUser = {
  id: USER_ID,
  clinicId: CLINIC_ID,
  email: "admin@example.com",
  fullName: "Admin",
  role: "admin",
  avatarUrl: null,
  departmentId: null,
  mustChangePassword: false,
};

class RecordingConfirmationStore implements ActionConfirmationStore {
  issued: Parameters<ActionConfirmationStore["issue"]>[0][] = [];

  async issue(input: Parameters<ActionConfirmationStore["issue"]>[0]) {
    this.issued.push(input);
  }

  async claim(): Promise<ConfirmationClaimOutcome> {
    return "invalid";
  }
}

class MemoryLedger implements ActionReceiptLedger {
  finals: Parameters<ActionReceiptLedger["finalize"]>[0][] = [];

  async begin() {
    return "00000000-0000-4000-8000-000000000099";
  }

  async finalize(input: Parameters<ActionReceiptLedger["finalize"]>[0]) {
    this.finals.push(input);
  }
}

async function loadPreviewHarness() {
  vi.resetModules();
  const mocks = createServerActionMocks();

  vi.doMock("next/cache", () => ({
    revalidatePath: mocks.state.revalidatePath,
    revalidateTag: vi.fn(),
  }));
  vi.doMock("@/lib/supabase/server", () => ({
    createClient: vi.fn(async () => mocks.client()),
  }));
  vi.doMock("@/lib/supabase/admin", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/supabase/admin")>();
    return {
      ...actual,
      createAdminClient: vi.fn(() => mocks.client()),
      createClinicScopedAdminClient: vi.fn(() => mocks.client()),
    };
  });
  vi.doMock("@/lib/ai/authorization", () => ({
    assertStaffToolAccess: vi.fn(async () => undefined),
  }));
  vi.doMock("@/lib/entitlements", () => ({
    getEntitlements: vi.fn(async () => ({
      subscriptionAllowed: true,
      planSlug: "pro_ai",
      features: {},
      limits: {},
    })),
    hasFeature: vi.fn(() => true),
  }));
  vi.doMock("@/lib/ai/permissions", () => ({
    hasAiUserPermission: vi.fn(async () => true),
  }));
  vi.doMock("@/lib/server-page-permissions", () => ({
    getPageVisibilityState: vi.fn(async () => "visible"),
  }));

  const { previewRegisteredAction } = await import("@/lib/ai/actions/execute");
  return { mocks, previewRegisteredAction };
}

beforeEach(() => {
  vi.restoreAllMocks();
  process.env.AI_ACTION_CONFIRMATION_HMAC_KEY = Buffer.alloc(32, 7).toString(
    "base64",
  );
});

describe("Phase 5 destructive preview fidelity", () => {
  for (const actionId of ["patients.soft_delete", "patients.archive"] as const) {
    it(`${actionId} names the exact authorized patient before issuing confirmation`, async () => {
      const { mocks, previewRegisteredAction } = await loadPreviewHarness();
      mocks.state.tableResults["patients.select"] = {
        data: {
          id: PATIENT_ID,
          full_name: "Maya Patient",
          file_number: "CF-0042",
          is_deleted: actionId === "patients.archive",
          is_archived: false,
          deleted_at:
            actionId === "patients.archive"
              ? "2026-08-14T10:00:00.000Z"
              : null,
          archived_at: null,
        },
        error: null,
      };
      const store = new RecordingConfirmationStore();
      const result = await previewRegisteredAction({
        user: USER,
        conversationId: CONVERSATION_ID,
        actionId,
        actionInput: { patient_id: PATIENT_ID },
        confirmationStore: store,
        receiptLedger: new MemoryLedger(),
      });

      expect(result).toMatchObject({
        phase: "preview",
        confirmation_required: true,
      });
      if ("preview" in result) {
        const identifier = result.preview.changes[0];
        expect(identifier).toMatchObject({
          label: "patient",
          before: expect.stringContaining("Maya Patient"),
          after: expect.stringContaining("CF-0042"),
          identifiesRecord: true,
        });
        expect(identifier.before).toContain(PATIENT_ID);
        expect(identifier.after).toContain(PATIENT_ID);
      }
      expect(store.issued).toHaveLength(1);
      expect(mocks.state.queryLog).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "patients",
            operation: "select",
            args: ["eq", "id", PATIENT_ID],
          }),
          expect.objectContaining({
            table: "patients",
            operation: "select",
            args: ["eq", "clinic_id", CLINIC_ID],
          }),
        ]),
      );
    });
  }

  it("refuses an absent or cross-tenant patient before minting a confirmation", async () => {
    const { mocks, previewRegisteredAction } = await loadPreviewHarness();
    mocks.state.tableResults["patients.select"] = {
      data: null,
      error: null,
    };
    const store = new RecordingConfirmationStore();
    const ledger = new MemoryLedger();
    const result = await previewRegisteredAction({
      user: USER,
      conversationId: CONVERSATION_ID,
      actionId: "patients.soft_delete",
      actionInput: { patient_id: PATIENT_ID },
      confirmationStore: store,
      receiptLedger: ledger,
    });

    expect(result).toMatchObject({
      action_denied: true,
      confirmation_required: false,
      reason: "business_rule_violation",
    });
    expect(store.issued).toHaveLength(0);
    expect(ledger.finals[0]).toMatchObject({
      outcome: "business_rule_refused",
      errorCode: "patients.patientNotFound",
    });
  });

  it("billing undo leads with patient, file, patient id, and appointment id", async () => {
    const { mocks, previewRegisteredAction } = await loadPreviewHarness();
    mocks.state.tableResults["appointments.select"] = {
      data: {
        id: APPOINTMENT_ID,
        patient_id: PATIENT_ID,
        scheduled_at: "2026-08-14T10:00:00.000Z",
        status: "completed",
        total_amount: 100,
        paid_amount: 100,
        outstanding_amount: 0,
        patients: {
          full_name: "Maya Patient",
          file_number: "CF-0042",
        },
      },
      error: null,
    };
    mocks.state.tableResults["activity_events.select"] = {
      data: {
        id: "00000000-0000-4000-8000-000000000015",
        action: "appointment.completed",
        occurred_at: new Date().toISOString(),
        previous_state: { status: "confirmed" },
      },
      error: null,
    };
    mocks.state.tableResults["outstanding_settlements.select"] = {
      data: [],
      error: null,
    };
    const result = await previewRegisteredAction({
      user: USER,
      conversationId: CONVERSATION_ID,
      actionId: "billing.undo_appointment_completion",
      actionInput: { appointment_id: APPOINTMENT_ID },
      confirmationStore: new RecordingConfirmationStore(),
      receiptLedger: new MemoryLedger(),
    });

    expect(result).toMatchObject({
      confirmation_required: true,
    });
    if ("preview" in result) {
      expect(result.preview.changes[0]).toMatchObject({
        label: "appointment",
        identifiesRecord: true,
      });
      const identifier = String(result.preview.changes[0]?.before);
      expect(identifier).toContain("Maya Patient");
      expect(identifier).toContain("CF-0042");
      expect(identifier).toContain(PATIENT_ID);
      expect(identifier).toContain(APPOINTMENT_ID);
      expect(result.preview.changes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ before: expect.stringMatching(/^\s*\{/) }),
        ]),
      );
    }
  });
});
