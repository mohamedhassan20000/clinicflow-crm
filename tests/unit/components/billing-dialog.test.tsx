import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  BillingDialog,
  type BillingPayload,
} from "@/components/appointments/billing-dialog";

const basePayload: BillingPayload = {
  line_items: [
    {
      service_id: null,
      name: "Consultation",
      price: 100,
      quantity: 1,
    },
  ],
  paid_amount: 100,
  payment_method: "cash",
  insurance_amount: 0,
  insurance_calculation_mode: "amount",
  insurance_percentage: null,
  patient_responsibility: 100,
  secondary_payment_method: null,
  secondary_amount: 0,
  deposit_amount: 0,
  payment_note: null,
};

function renderDialog({
  previousOutstandingBalance = 0,
  accountBalance = 0,
  initialPayload = basePayload,
  onConfirm,
  previousOutstandingAction,
}: {
  previousOutstandingBalance?: number;
  accountBalance?: number;
  initialPayload?: BillingPayload | null;
  onConfirm?: (payload: BillingPayload) => void;
  previousOutstandingAction?: React.ReactNode;
} = {}) {
  const confirm = vi.fn(onConfirm);
  render(
    <BillingDialog
      open
      onOpenChange={vi.fn()}
      onConfirm={confirm}
      services={[]}
      accountBalance={accountBalance}
      previousOutstandingBalance={previousOutstandingBalance}
      previousOutstandingAction={previousOutstandingAction}
      initialPayload={initialPayload}
      draftKey={1}
    />,
  );
  return { onConfirm: confirm };
}

async function waitForInvoicePayload() {
  await screen.findByDisplayValue("Consultation");
}

function previousSection() {
  const title = screen.getByText("Previous outstanding balance");
  const section = title.closest("section");
  if (!section) throw new Error("Previous balance section not found");
  return within(section);
}

describe("BillingDialog previous outstanding balance", () => {
  it("keeps its header and actions outside a viewport-bounded internal scroller", async () => {
    renderDialog({ previousOutstandingBalance: 125 });
    await waitForInvoicePayload();

    const dialog = screen.getByRole("dialog");
    const scroller = screen.getByTestId("billing-dialog-scroll-area");
    const header = screen
      .getByRole("heading", { name: "Invoice — complete appointment" })
      .closest('[data-slot="dialog-header"]');
    const submit = screen.getByRole("button", { name: "Complete & charge" });
    const footer = submit.closest('[data-slot="dialog-footer"]');

    expect(dialog).toHaveClass(
      "max-h-[calc(100dvh-1rem)]",
      "sm:max-h-[calc(100dvh-2rem)]",
      "overflow-hidden",
    );
    expect(scroller).toHaveClass(
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overscroll-contain",
    );
    expect(header).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(scroller.contains(header)).toBe(false);
    expect(scroller.contains(footer)).toBe(false);
    expect(document.body).toHaveAttribute("data-scroll-locked");
  });

  it("does not render the previous balance section when balance is zero", async () => {
    renderDialog({ previousOutstandingBalance: 0 });
    await waitForInvoicePayload();

    expect(
      screen.queryByText("Previous outstanding balance"),
    ).not.toBeInTheDocument();
  });

  it("renders the previous balance section when a balance exists", async () => {
    renderDialog({ previousOutstandingBalance: 125 });
    await waitForInvoicePayload();

    const section = previousSection();
    expect(section.getByText(/Previous balance:/i)).toBeInTheDocument();
    expect(
      section.getByText(
        "Optional payment toward older unpaid appointments. This is recorded separately from today's invoice.",
      ),
    ).toBeInTheDocument();
  });

  it("renders a separate previous balance payment action", async () => {
    renderDialog({
      previousOutstandingBalance: 125,
      previousOutstandingAction: <button type="button">Pay separately</button>,
    });
    await waitForInvoicePayload();

    const section = previousSection();
    expect(
      section.getByText(/separate outstanding-balance payment/i),
    ).toBeInTheDocument();
    expect(
      section.getByRole("button", { name: "Pay separately" }),
    ).toBeInTheDocument();
  });

  it("submits previous settlement fields without adding service lines", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ previousOutstandingBalance: 125 });
    await waitForInvoicePayload();

    const section = previousSection();
    await user.clear(section.getByLabelText("Settle now"));
    await user.type(section.getByLabelText("Settle now"), "25");
    await user.click(section.getByRole("button", { name: "Cash" }));
    await user.type(
      section.getByLabelText("Previous balance note (optional)"),
      "Old balance receipt",
    );
    await user.click(screen.getByRole("button", { name: "Complete & charge" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          {
            service_id: null,
            name: "Consultation",
            price: 100,
            quantity: 1,
          },
        ],
        previous_settlement_amount: 25,
        previous_payment_method: "cash",
        previous_note: "Old balance receipt",
      }),
    );
    expect(onConfirm.mock.calls[0][0].line_items).toHaveLength(1);
  });

  it("disables submit when previous settlement exceeds balance", async () => {
    const user = userEvent.setup();
    renderDialog({ previousOutstandingBalance: 25 });
    await waitForInvoicePayload();

    const section = previousSection();
    await user.type(section.getByLabelText("Settle now"), "30");
    await user.click(section.getByRole("button", { name: "Cash" }));

    expect(
      section.getByText("Amount cannot exceed the previous balance."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Complete & charge" }),
    ).toBeDisabled();
  });

  it("blocks negative previous settlement values", async () => {
    const user = userEvent.setup();
    renderDialog({ previousOutstandingBalance: 25 });
    await waitForInvoicePayload();

    const section = previousSection();
    await user.type(section.getByLabelText("Settle now"), "-1");

    expect(
      section.getByText("Enter a positive amount or leave this blank."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Complete & charge" }),
    ).toBeDisabled();
  });

  it("requires previous payment method only when settling previous balance", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ previousOutstandingBalance: 25 });
    await waitForInvoicePayload();

    const section = previousSection();
    await user.click(screen.getByRole("button", { name: "Complete & charge" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.not.objectContaining({
        previous_settlement_amount: expect.any(Number),
      }),
    );

    onConfirm.mockClear();
    await user.type(section.getByLabelText("Settle now"), "10");

    expect(
      section.getByText("Select a payment method for previous balance."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Complete & charge" }),
    ).toBeDisabled();
  });

  it("shows total collected today as current collected plus previous settlement", async () => {
    const user = userEvent.setup();
    renderDialog({
      previousOutstandingBalance: 80,
      initialPayload: {
        ...basePayload,
        paid_amount: 40,
      },
    });
    await waitForInvoicePayload();

    const section = previousSection();
    await user.type(section.getByLabelText("Settle now"), "25");

    await waitFor(() => {
      expect(section.getByText("Total collected today")).toBeInTheDocument();
      expect(section.getByText(/65\.00/)).toBeInTheDocument();
    });
  });
});

describe("BillingDialog insurance allocation", () => {
  it("fills a one-method patient payment after fixed insurance", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      initialPayload: {
        ...basePayload,
        line_items: [
          {
            service_id: null,
            name: "Treatment",
            price: 5800,
            quantity: 1,
          },
        ],
        paid_amount: 0,
        insurance_amount: 870,
        patient_responsibility: 4930,
      },
    });
    await screen.findByDisplayValue("Treatment");

    await user.click(screen.getByTestId("fill-primary-remaining"));

    expect(screen.getByLabelText("Primary payment")).toHaveValue(4930);
    await user.click(screen.getByRole("button", { name: "Complete & charge" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        paid_amount: 4930,
        insurance_amount: 870,
        patient_responsibility: 4930,
        secondary_amount: 0,
        deposit_amount: 0,
      }),
    );
  });

  it("fills the exact secondary remainder for the screenshot split allocation", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      initialPayload: {
        ...basePayload,
        line_items: [
          {
            service_id: null,
            name: "Treatment",
            price: 5800,
            quantity: 1,
          },
        ],
        paid_amount: 2800,
        insurance_amount: 870,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 4930,
        secondary_payment_method: "credit_card",
        secondary_amount: 0,
      },
    });
    await screen.findByDisplayValue("Treatment");

    await user.click(screen.getByTestId("fill-secondary-remaining"));

    expect(screen.getByLabelText("Paid via another method")).toHaveValue(2130);
    await user.click(screen.getByRole("button", { name: "Complete & charge" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        paid_amount: 2800,
        insurance_amount: 870,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 4930,
        secondary_amount: 2130,
        deposit_amount: 0,
      }),
    );
  });

  it("recalculates the secondary fill target after payment, deposit, insurance, and total changes", async () => {
    const user = userEvent.setup();
    renderDialog({
      accountBalance: 500,
      initialPayload: {
        ...basePayload,
        line_items: [
          {
            service_id: null,
            name: "Treatment",
            price: 5800,
            quantity: 1,
          },
        ],
        paid_amount: 2800,
        insurance_amount: 870,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 4930,
        secondary_payment_method: "credit_card",
        secondary_amount: 0,
      },
    });
    await screen.findByDisplayValue("Treatment");

    const primary = screen.getByLabelText("Primary payment");
    const deposit = screen.getByLabelText("Apply from patient account");
    const percentage = screen.getByLabelText("Insurance percentage");
    const price = screen.getByDisplayValue("5800");

    await user.clear(primary);
    await user.type(primary, "2700");
    await user.type(deposit, "100");
    await user.clear(percentage);
    await user.type(percentage, "10");
    await user.clear(price);
    await user.type(price, "6000");
    await user.click(screen.getByTestId("fill-secondary-remaining"));

    // 6,000 - 10% insurance - 2,700 primary - 100 deposit.
    expect(screen.getByLabelText("Paid via another method")).toHaveValue(2600);
  });

  it("keeps a fixed insurance amount separate from patient payment methods", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      initialPayload: {
        ...basePayload,
        paid_amount: 70,
        insurance_amount: 30,
        patient_responsibility: 70,
      },
    });
    await waitForInvoicePayload();

    expect(screen.getByRole("heading", { name: "Insurance" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insurance" })).not.toBeInTheDocument();
    expect(screen.getByTestId("calculated-insurance-amount")).toHaveTextContent(
      "30.00",
    );

    await user.click(screen.getByRole("button", { name: "Complete & charge" }));

    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        insurance_amount: 30,
        insurance_calculation_mode: "amount",
        insurance_percentage: null,
        patient_responsibility: 70,
        paid_amount: 70,
      }),
    );
  });

  it("calculates percentage insurance live and persists the selected input", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      initialPayload: {
        ...basePayload,
        paid_amount: 85,
        insurance_amount: 15,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 85,
      },
    });
    await waitForInvoicePayload();

    expect(screen.getByLabelText("Insurance percentage")).toHaveValue(15);
    expect(screen.getByTestId("calculated-insurance-amount")).toHaveTextContent(
      "15.00",
    );

    await user.click(screen.getByRole("button", { name: "Complete & charge" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        insurance_amount: 15,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 85,
      }),
    );
  });

  it("requires an explicit percentage after percentage mode is selected", async () => {
    renderDialog({
      initialPayload: {
        ...basePayload,
        insurance_calculation_mode: "percentage",
        insurance_percentage: null,
      },
    });
    await waitForInvoicePayload();

    expect(screen.getByText("Enter an insurance percentage.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Complete & charge" }),
    ).toBeDisabled();
  });

  it.each([
    { percentage: 0, insurance: 0, responsibility: 100 },
    { percentage: 100, insurance: 100, responsibility: 0 },
  ])(
    "supports $percentage% insurance",
    async ({ percentage, insurance, responsibility }) => {
      renderDialog({
        initialPayload: {
          ...basePayload,
          paid_amount: responsibility,
          insurance_amount: insurance,
          insurance_calculation_mode: "percentage",
          insurance_percentage: percentage,
          patient_responsibility: responsibility,
        },
      });
      await waitForInvoicePayload();

      expect(screen.getByLabelText("Insurance percentage")).toHaveValue(
        percentage,
      );
      expect(
        screen.getByTestId("calculated-insurance-amount"),
      ).toHaveTextContent(insurance.toFixed(2));
      expect(
        screen.getByRole("button", {
          name: responsibility > 0 ? "Complete & charge" : "Complete & charge",
        }),
      ).toBeEnabled();
    },
  );

  it("recalculates percentage insurance when the invoice total changes", async () => {
    const user = userEvent.setup();
    renderDialog({
      initialPayload: {
        ...basePayload,
        paid_amount: 85,
        insurance_amount: 15,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 15,
        patient_responsibility: 85,
      },
    });
    await waitForInvoicePayload();

    const linePrice = screen.getByDisplayValue("100");
    await user.clear(linePrice);
    await user.type(linePrice, "200");

    expect(screen.getByTestId("calculated-insurance-amount")).toHaveTextContent(
      "30.00",
    );
  });

  it("does not silently clamp a fixed amount when invoice total drops", async () => {
    const user = userEvent.setup();
    renderDialog({
      initialPayload: {
        ...basePayload,
        paid_amount: 70,
        insurance_amount: 30,
        patient_responsibility: 70,
      },
    });
    await waitForInvoicePayload();

    const linePrice = screen.getByDisplayValue("100");
    await user.clear(linePrice);
    await user.type(linePrice, "20");

    expect(screen.getByLabelText("Insurance amount")).toHaveValue(30);
    expect(
      screen.getByText("Insurance contribution cannot exceed the invoice total."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete & charge" })).toBeDisabled();
  });

  it("validates split patient payments against responsibility after insurance", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      initialPayload: {
        ...basePayload,
        paid_amount: 40,
        insurance_amount: 30,
        patient_responsibility: 70,
        secondary_payment_method: "credit_card",
        secondary_amount: 30,
      },
    });
    await waitForInvoicePayload();

    await user.click(screen.getByRole("button", { name: "Complete & charge" }));
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({
        paid_amount: 40,
        secondary_amount: 30,
        insurance_amount: 30,
        patient_responsibility: 70,
      }),
    );
  });

  it("restores persisted percentage mode when the invoice draft is reopened", async () => {
    renderDialog({
      initialPayload: {
        ...basePayload,
        paid_amount: 75,
        insurance_amount: 25,
        insurance_calculation_mode: "percentage",
        insurance_percentage: 25,
        patient_responsibility: 75,
      },
    });
    await waitForInvoicePayload();

    expect(screen.getByLabelText("Calculation mode")).toHaveTextContent(
      "Percentage",
    );
    expect(screen.getByLabelText("Insurance percentage")).toHaveValue(25);
  });
});
