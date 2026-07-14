import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AuthLayout from "@/app/(auth)/layout";

function renderAuthLayout() {
  return render(
    <AuthLayout>
      <p>Authentication content</p>
    </AuthLayout>,
  );
}

describe("Post-Pre-P2 MP4 login navigation", () => {
  it("points the desktop and mobile brand lockups at the marketing landing page", () => {
    renderAuthLayout();

    const lockups = screen.getAllByRole("link", { name: "ClinicFlow home" });
    expect(lockups).toHaveLength(2);

    for (const lockup of lockups) {
      expect(lockup).toHaveAttribute("href", "/");
      expect(lockup.querySelector("img")).not.toBeNull();
      expect(lockup).toHaveTextContent("ClinicFlow");
    }
  });

  it("keeps each lockup a single focusable link with no nested interactive element", () => {
    const { container } = renderAuthLayout();

    for (const lockup of screen.getAllByRole("link", { name: "ClinicFlow home" })) {
      expect(
        lockup.querySelectorAll("a, button, [tabindex]:not([tabindex='-1'])"),
      ).toHaveLength(0);
    }

    const authLinks = Array.from(container.querySelectorAll("a")).map((link) =>
      link.getAttribute("href"),
    );
    expect(authLinks).not.toContain("/login");
  });
});
