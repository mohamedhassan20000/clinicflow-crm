import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrphanTruncationWarning } from "@/components/operator/orphan-truncation-warning";

describe("P1.5B orphan scan warning", () => {
  it("renders the safety warning when the scan is truncated", () => {
    render(<OrphanTruncationWarning truncated />);
    expect(screen.getByRole("alert")).toHaveTextContent(/list may be incomplete/i);
  });

  it("does not render a warning for a complete scan", () => {
    render(<OrphanTruncationWarning truncated={false} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
