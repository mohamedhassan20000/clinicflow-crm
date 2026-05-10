import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatientProfilePrintButton } from "@/components/patients/patient-profile-print-button";

describe("PatientProfilePrintButton", () => {
  beforeEach(() => {
    vi.spyOn(window, "print").mockImplementation(() => {});
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 0;
    });
  });

  afterEach(() => {
    document.body.classList.remove("patient-profile-print");
    vi.restoreAllMocks();
  });

  it("adds patient print mode and calls window.print", async () => {
    const user = userEvent.setup();
    render(<PatientProfilePrintButton />);

    await user.click(screen.getByRole("button", { name: /print/i }));

    await waitFor(() => {
      expect(window.print).toHaveBeenCalled();
    });
    expect(document.body).toHaveClass("patient-profile-print");
  });
});
