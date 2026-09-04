import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/actions/settings", () => ({
  updateInvoiceFollowupSettings: mocks.update,
}));
vi.mock("sonner", () => ({
  toast: { error: mocks.error, success: mocks.success },
}));

import { InvoiceFollowupSettingsCard } from "@/components/settings/invoice-followup-settings-card";

describe("Phase 5 invoice follow-up validation UI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the server validation error and never reports success", async () => {
    mocks.update.mockResolvedValue({
      error: "Second reminder must come after the first.",
      fieldErrors: {
        second_days: ["Second reminder must come after the first."],
      },
    });
    const user = userEvent.setup();
    render(
      <InvoiceFollowupSettingsCard
        enabled
        firstDays={10}
        secondDays={20}
        emailSubject={null}
        emailBody={null}
        clinicName="Nile Dental"
        canManage
      />,
    );

    const inputs = screen.getAllByRole("spinbutton");
    await user.clear(inputs[1]);
    await user.type(inputs[1], "5");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "Second reminder must come after the first.",
      ),
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  /**
   * `invoiceFollowupEmailSubjectPlaceholder` takes `{clinicName}`. Calling it
   * without one made next-intl throw `FORMATTING_ERROR` while rendering the
   * card, so the argument is asserted here rather than assumed.
   */
  it("renders the subject placeholder with the clinic's own name", () => {
    render(
      <InvoiceFollowupSettingsCard
        enabled
        firstDays={3}
        secondDays={7}
        emailSubject={null}
        emailBody={null}
        clinicName="Nile Dental"
        canManage
      />,
    );

    expect(
      screen.getByPlaceholderText("Outstanding balance — Nile Dental"),
    ).toBeTruthy();
  });

  it("falls back to the field label when the clinic name is unavailable", () => {
    render(
      <InvoiceFollowupSettingsCard
        enabled
        firstDays={3}
        secondDays={7}
        emailSubject={null}
        emailBody={null}
        clinicName=""
        canManage
      />,
    );

    expect(screen.getByPlaceholderText("Email subject")).toBeTruthy();
  });
});
