import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettleOutstandingDialog } from "@/components/patients/settle-outstanding-dialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/actions/patients", () => ({
  settleOutstanding: vi.fn(),
}));

describe("SettleOutstandingDialog", () => {
  it("opens the existing outstanding settlement flow from a custom trigger", async () => {
    const user = userEvent.setup();
    render(
      <SettleOutstandingDialog
        patientId="patient-1"
        outstanding={125}
        patientName="Test Patient"
        triggerLabel="Pay separately"
      />,
    );

    const trigger = screen.getByRole("button", { name: /pay separately/i });
    expect(trigger).toHaveAttribute("type", "button");

    await user.click(trigger);

    expect(
      screen.getByRole("heading", { name: /settle outstanding balance/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Test Patient/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("125")).toBeInTheDocument();
  });
});
