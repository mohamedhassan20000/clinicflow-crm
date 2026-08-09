import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DateRangePicker,
  DateTimePicker,
  MonthPicker,
  SingleDatePicker,
  TimePicker,
} from "@/components/ui/clinic-date-picker";

describe("Clinic date pickers", () => {
  it("keeps From and To as independent controlled values while guiding range selection", async () => {
    const user = userEvent.setup();
    const onFromChange = vi.fn();
    const onToChange = vi.fn();
    const { container } = render(
      <DateRangePicker
        from="2026-07-10"
        to="2026-07-20"
        labels={{ from: "From", to: "To" }}
        onFromChange={onFromChange}
        onToChange={onToChange}
      />,
    );

    await user.click(container.querySelector('[data-range-edge="from"]')!);
    expect(screen.getByRole("grid", { name: "Calendar" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Month" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Year" })).toBeVisible();
    expect(screen.getByRole("gridcell", { name: /July 21, 2026/ })).not.toBeDisabled();

    await user.click(screen.getByRole("gridcell", { name: /July 15, 2026/ }));
    expect(onFromChange).toHaveBeenCalledWith("2026-07-15");
    expect(onToChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("gridcell", { name: /July 18, 2026/ }));
    expect(onToChange).toHaveBeenCalledWith("2026-07-18");
    expect(screen.queryByRole("grid", { name: "Calendar" })).not.toBeInTheDocument();
  });

  it("preserves range bounds by disabling dates outside the caller's existing limits", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DateRangePicker
        from="2026-07-10"
        to="2026-07-20"
        min="2026-07-01"
        max="2026-07-31"
        labels={{ from: "From", to: "To" }}
        onFromChange={() => {}}
        onToChange={() => {}}
        enforceOrder
      />,
    );

    await user.click(container.querySelector('[data-range-edge="from"]')!);
    expect(screen.getByRole("gridcell", { name: /July 21, 2026/ })).toBeDisabled();
    expect(screen.getByRole("gridcell", { name: /July 9, 2026/ })).not.toBeDisabled();
  });

  it("returns the same YYYY-MM-DD contract from the single-date calendar", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SingleDatePicker
        value="2026-07-10"
        label="New date and time"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /New date and time/i }));
    await user.click(screen.getByRole("gridcell", { name: /July 22, 2026/ }));
    expect(onChange).toHaveBeenCalledWith("2026-07-22");
  });

  it("supports uncontrolled named date fields without changing form submission values", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SingleDatePicker name="expiresAt" defaultValue="2026-07-10" label="Expires" />,
    );

    await user.click(screen.getByRole("button", { name: /Expires/i }));
    await user.click(screen.getByRole("gridcell", { name: /July 22, 2026/ }));
    expect(container.querySelector('input[name="expiresAt"]')).toHaveValue("2026-07-22");
  });

  it("returns the existing YYYY-MM contract from the shared month picker", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<MonthPicker value="2026-07" label="Month" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Month/i }));
    await user.click(screen.getByRole("button", { name: /August 2026/i }));
    expect(onChange).toHaveBeenCalledWith("2026-08");
  });

  it("returns the existing HH:mm contract from the shared time picker", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimePicker value="08:15" label="Start time" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Start time/i }));
    await user.click(screen.getByRole("combobox", { name: "Minute" }));
    await user.click(screen.getByRole("option", { name: "45" }));
    expect(onChange).toHaveBeenCalledWith("08:45");
  });

  it("preserves local date-time strings when composing date and time selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateTimePicker
        value="2026-07-10T08:15"
        dateLabel="Date"
        timeLabel="Time"
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: /^Date/i }));
    await user.click(screen.getByRole("gridcell", { name: /July 22, 2026/ }));
    expect(onChange).toHaveBeenCalledWith("2026-07-22T08:15");
  });
});
