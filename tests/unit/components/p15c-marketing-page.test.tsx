import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketingPage } from "@/components/marketing/marketing-page";

describe("P1.5C marketing page", () => {
  it("renders every required section and sends the primary CTA to login", () => {
    render(<MarketingPage registrationMode="invite_only" weeklyLimit={20} acceptedThisWeek={7} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your clinic");
    for (const id of ["product", "features", "pricing", "early-access", "faq", "contact"]) expect(document.getElementById(id)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Try ClinicFlow" })).toHaveAttribute("href", "/login");
    expect(screen.getByText("7 of 20 spots taken this week")).toBeInTheDocument();
  });

  it("offers open signup when registration mode is open", () => {
    render(<MarketingPage registrationMode="open" weeklyLimit={20} acceptedThisWeek={0} />);
    expect(screen.getByRole("link", { name: "Create your clinic" })).toHaveAttribute("href", "/signup");
  });

  it("renders an accessible mobile navigation trigger", () => {
    render(<MarketingPage registrationMode="invite_only" weeklyLimit={20} acceptedThisWeek={0} />);
    expect(screen.getByRole("button", { name: "Open navigation menu" })).toBeInTheDocument();
  });
});
