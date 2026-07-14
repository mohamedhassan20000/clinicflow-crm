import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OperatorError from "@/app/(operator)/error";
import OperatorNotFound from "@/app/(operator)/not-found";

describe("Post-Pre-P2 MP0 operator route boundaries", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a recoverable, no-PHI error card with only the safe digest", () => {
    const reset = vi.fn();
    const error = Object.assign(
      new Error("patientName=Private Patient; nationalId=SECRET"),
      { digest: "mp0-safe-digest" },
    );

    render(<OperatorError error={error} reset={reset} />);

    expect(
      screen.getByRole("heading", { name: "Operator page could not be loaded" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Error ID: mp0-safe-digest")).toBeInTheDocument();
    expect(screen.queryByText(/Private Patient|SECRET/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Go to Mission Control" }),
    ).toHaveAttribute("href", "/operator");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("keeps an unknown operator route inside the operator shell", () => {
    render(<OperatorNotFound />);

    expect(
      screen.getByRole("heading", { name: "Operator page not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Go to Mission Control" }),
    ).toHaveAttribute("href", "/operator");
  });
});
