import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentActions } from "@/components/appointments/appointment-actions";
import type { BillingUndoEligibility } from "@/lib/appointments/billing-undo";

const actionMocks = vi.hoisted(() => ({
  getInvoiceUndoEligibility: vi.fn(),
  undoInvoiceCompletion: vi.fn(),
  refresh: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: actionMocks.refresh,
    push: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: actionMocks.toastError,
    success: actionMocks.toastSuccess,
    message: vi.fn(),
  },
}));

vi.mock("@/actions/appointments", () => ({
  arriveAppointment: vi.fn(),
  getBillingContext: vi.fn(),
  getInvoiceUndoEligibility: actionMocks.getInvoiceUndoEligibility,
  startAppointmentSession: vi.fn(),
  updateAppointmentStatus: vi.fn(),
  undoAppointmentStatus: vi.fn(),
  undoInvoiceCompletion: actionMocks.undoInvoiceCompletion,
  getConflictingPendingAppointments: vi.fn(),
}));

vi.mock("@/components/appointments/billing-dialog", () => ({
  BillingDialog: () => null,
}));
vi.mock("@/components/appointments/cancel-dialog", () => ({
  CancelAppointmentDialog: () => null,
}));
vi.mock("@/components/appointments/noshow-dialog", () => ({
  NoShowDialog: () => null,
}));
vi.mock("@/components/appointments/replace-appointment-dialog", () => ({
  ReplaceAppointmentDialog: () => null,
}));
vi.mock("@/components/appointments/conflict-resolution-modal", () => ({
  ConflictResolutionModal: () => null,
}));
vi.mock("@/components/patients/settle-outstanding-dialog", () => ({
  SettleOutstandingDialog: () => null,
}));

function eligibility(
  overrides: Partial<BillingUndoEligibility> = {},
): BillingUndoEligibility {
  return {
    canUndo: true,
    reason: "eligible",
    targetStatus: "confirmed",
    completionEventId: "event-1",
    completionOccurredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    ...overrides,
  };
}

function renderCompleted(role: "admin" | "receptionist" | "manager" | "doctor" = "receptionist") {
  return render(
    <AppointmentActions
      appointmentId="appointment-1"
      currentStatus="completed"
      currentUserRole={role}
      showBillingUndo
    />,
  );
}

describe("AppointmentActions billing Undo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actionMocks.getInvoiceUndoEligibility.mockResolvedValue(eligibility());
    actionMocks.undoInvoiceCompletion.mockResolvedValue({
      success: true,
      targetStatus: "confirmed",
      rpc: "undo_appointment_billing",
      eligibility: eligibility(),
    });
  });

  it("renders an enabled Undo after reopening a completed appointment", async () => {
    const first = renderCompleted();
    expect(
      await screen.findByRole("button", { name: "Undo completion" }),
    ).toBeEnabled();
    first.unmount();

    renderCompleted();

    expect(
      await screen.findByRole("button", { name: "Undo completion" }),
    ).toBeEnabled();
    expect(actionMocks.getInvoiceUndoEligibility).toHaveBeenCalledTimes(2);
  });

  it("keeps the button rendered but disabled with the expired reason", async () => {
    actionMocks.getInvoiceUndoEligibility.mockResolvedValue(
      eligibility({
        canUndo: false,
        reason: "expired",
        targetStatus: null,
      }),
    );

    renderCompleted();

    expect(
      await screen.findByRole("button", { name: "Undo completion" }),
    ).toBeDisabled();
    expect(
      screen.getByText("The 10-second Undo window has expired."),
    ).toBeVisible();
  });

  it("shows an authorization reason without enabling Undo", async () => {
    actionMocks.getInvoiceUndoEligibility.mockResolvedValue(
      eligibility({
        canUndo: false,
        reason: "unauthorized",
        targetStatus: null,
      }),
    );

    renderCompleted("doctor");

    expect(
      await screen.findByRole("button", { name: "Undo completion" }),
    ).toBeDisabled();
    expect(
      screen.getByText("Your role cannot undo appointment billing."),
    ).toBeVisible();
  });

  it("prevents duplicate clicks and shows a loading state", async () => {
    let resolveUndo:
      | ((value: {
          success: true;
          targetStatus: "confirmed";
          rpc: string;
          eligibility: BillingUndoEligibility;
        }) => void)
      | undefined;
    actionMocks.undoInvoiceCompletion.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveUndo = resolve;
        }),
    );
    renderCompleted();
    const button = await screen.findByRole("button", {
      name: "Undo completion",
    });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(actionMocks.undoInvoiceCompletion).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "Undoing…" }),
    ).toBeDisabled();

    resolveUndo?.({
      success: true,
      targetStatus: "confirmed",
      rpc: "undo_appointment_billing",
      eligibility: eligibility(),
    });

    await waitFor(() => expect(actionMocks.refresh).toHaveBeenCalledTimes(1));
    expect(actionMocks.toastSuccess).toHaveBeenCalledWith(
      "Billing completion undone.",
    );
  });
});
