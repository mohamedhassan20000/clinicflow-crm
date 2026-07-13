import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PageHeader } from "@/components/shared/page-header";

describe("PageHeader", () => {
  it("renders a semantic breadcrumb and a stable, visible back link before the heading", () => {
    render(
      <PageHeader
        back={{ href: "/operator/clinics?q=Demo&country=TR", label: "clinics" }}
        breadcrumbs={[
          { label: "Operator", href: "/operator" },
          { label: "Clinics", href: "/operator/clinics?q=Demo&country=TR" },
          { label: "Demo Clinic" },
        ]}
        title="Demo Clinic"
      />,
    );

    const back = screen.getByRole("link", { name: "Back to clinics" });
    const heading = screen.getByRole("heading", { level: 1, name: "Demo Clinic" });
    expect(back).toHaveAttribute("href", "/operator/clinics?q=Demo&country=TR");
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(screen.getByText("Demo Clinic", { selector: '[aria-current="page"]' })).toBeInTheDocument();
  });

  it("exposes the back link to keyboard focus with a visible focus style", async () => {
    const user = userEvent.setup();
    render(
      <PageHeader
        back={{ href: "/patients?name=Ada", label: "patients" }}
        breadcrumbs={[{ label: "Patients", href: "/patients?name=Ada" }, { label: "Ada" }]}
        title="Ada"
      />,
    );

    await user.tab();
    const back = screen.getByRole("link", { name: "Back to patients" });
    expect(back).toHaveFocus();
    expect(back.className).toContain("focus-visible:outline-ring");
  });
});
