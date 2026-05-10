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
  secondary_payment_method: null,
  secondary_amount: 0,
  deposit_amount: 0,
  payment_note: null,
};

function renderDialog({
  previousOutstandingBalance = 0,
  initialPayload = basePayload,
  onConfirm,
  previousOutstandingAction,
}: {
  previousOutstandingBalance?: number;
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
      accountBalance={0}
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
    await user.clear(section.getByLabelText("Settle now (₺)"));
    await user.type(section.getByLabelText("Settle now (₺)"), "25");
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
    await user.type(section.getByLabelText("Settle now (₺)"), "30");
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
    await user.type(section.getByLabelText("Settle now (₺)"), "-1");

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
    await user.type(section.getByLabelText("Settle now (₺)"), "10");

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
    await user.type(section.getByLabelText("Settle now (₺)"), "25");

    await waitFor(() => {
      expect(section.getByText("Total collected today")).toBeInTheDocument();
      expect(section.getByText(/65\.00/)).toBeInTheDocument();
    });
  });
});
