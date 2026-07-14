import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import AuthLayout from "@/app/(auth)/layout";
import SignupLayout from "@/app/(public)/signup/layout";
import AuthCallbackLayout from "@/app/auth/layout";
import { LegalPage } from "@/components/marketing/legal-page";
import {
  MARKETING_SECTION_TONES,
  MarketingPage,
} from "@/components/marketing/marketing-page";

function expectForcedScope(
  element: Element | null,
  theme: "light" | "dark",
) {
  expect(element).not.toBeNull();
  expect(element).toHaveClass(theme);
  expect(element).toHaveClass(`forced-${theme}-scope`);
}

function expectPublicScope(element: Element | null, theme: "light" | "dark") {
  expect(element).not.toBeNull();
  expect(element).toHaveClass(theme, "forced-public-scope");
}

function surfaceOwnedClasses(container: HTMLElement) {
  return Array.from(container.querySelectorAll("[class]:not([data-slot])"))
    .map((element) => element.getAttribute("class"))
    .join(" ");
}

describe("Post-Pre-P2 MP1 theme scoping", () => {
  it("defaults marketing and legal surfaces to light with a local theme control", async () => {
    const user = userEvent.setup();
    const marketing = render(
      <MarketingPage
        registrationMode="invite_only"
        weeklyLimit={20}
        acceptedThisWeek={0}
      />,
    );
    expectPublicScope(marketing.container.firstElementChild, "light");
    await user.click(screen.getByRole("button", { name: "Switch marketing pages to dark mode" }));
    expectPublicScope(marketing.container.firstElementChild, "dark");
    marketing.unmount();

    const legal = render(<LegalPage document="privacy" />);
    expectPublicScope(legal.container.firstElementChild, "light");
    expect(surfaceOwnedClasses(legal.container)).toContain("dark:");
  });

  it("keeps the marketing section rhythm in one exported tone map", () => {
    expect(MARKETING_SECTION_TONES).toEqual({
      hero: "bg-[var(--m-paper)]",
      // P2C: the statistics band sits between the hero and the cohort proof.
      stats: "bg-[var(--m-panel)]",
      proof: "bg-[var(--m-panel)]",
      product: "bg-[var(--m-paper)]",
      features: "bg-[var(--m-warm)]",
      security: "bg-[#073846]",
      pricing: "bg-[var(--m-paper)]",
      earlyAccess: "bg-[var(--m-panel)]",
      faq: "bg-[var(--m-warm)]",
      footer: "bg-[#073846]",
    });
    expect(new Set(Object.values(MARKETING_SECTION_TONES))).toHaveLength(4);
  });

  it("renders every authentication layout with a forced-dark scope", () => {
    for (const Layout of [AuthLayout, SignupLayout, AuthCallbackLayout]) {
      const view = render(
        <Layout>
          <p>Authentication content</p>
        </Layout>,
      );
      expectForcedScope(view.container.firstElementChild, "dark");
      view.unmount();
    }
  });
});
