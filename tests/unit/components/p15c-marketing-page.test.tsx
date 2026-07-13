import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MarketingPage } from "@/components/marketing/marketing-page";

describe("WS9 marketing page", () => {
  it("renders the approved information architecture, real brand, and fictional product screens", () => {
    render(<MarketingPage registrationMode="invite_only" weeklyLimit={20} acceptedThisWeek={7} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("A clearer clinic day");
    for (const id of ["product", "features", "security", "pricing", "early-access", "faq", "contact"]) {
      expect(document.getElementById(id)).toBeTruthy();
    }
    expect(screen.getAllByRole("link", { name: "ClinicFlow home" })).toHaveLength(2);
    expect(screen.getAllByText("7 of 20 clinic spots taken this week")).toHaveLength(2);
    expect(screen.getByRole("progressbar", { name: "Weekly early-access cohort progress" })).toHaveAttribute("aria-valuenow", "7");
    expect(screen.getAllByText("Product screens show fictional demo data only.")).toHaveLength(1);
    expect(screen.getByAltText(/administrator dashboard showing daily appointments/i)).toBeInTheDocument();
    expect(screen.getByAltText(/week calendar showing fictional appointments/i)).toBeInTheDocument();
  });

  it("keeps login available while making early access the primary conversion", () => {
    render(<MarketingPage registrationMode="invite_only" weeklyLimit={20} acceptedThisWeek={0} />);
    expect(screen.getAllByRole("link", { name: "Log in" })[0]).toHaveAttribute("href", "/login");
    expect(screen.getAllByRole("button", { name: "Request early access" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Request an invitation" }).length).toBeGreaterThan(0);
  });

  it("offers open signup when registration mode is open", () => {
    render(<MarketingPage registrationMode="open" weeklyLimit={20} acceptedThisWeek={0} />);
    expect(screen.getAllByRole("link", { name: "Create your clinic" }).length).toBeGreaterThan(0);
  });

  it("renders an accessible mobile navigation trigger", () => {
    render(<MarketingPage registrationMode="invite_only" weeklyLimit={20} acceptedThisWeek={0} />);
    expect(screen.getByRole("button", { name: "Open navigation menu" })).toBeInTheDocument();
  });

  it("loads the existing early-access form only when its dialog opens", async () => {
    const user = userEvent.setup();
    render(<MarketingPage registrationMode="invite_only" weeklyLimit={20} acceptedThisWeek={0} />);

    expect(screen.queryByLabelText("Clinic name")).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Request early access" })[0]);

    expect(await screen.findByLabelText("Clinic name", {}, { timeout: 10_000 })).toBeEnabled();
    expect(screen.getByLabelText("Phone")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Request invitation" })).toBeEnabled();
  });

  it("links both legal placeholders from the footer", () => {
    render(<MarketingPage registrationMode="invite_only" weeklyLimit={20} acceptedThisWeek={0} />);
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
  });
});
